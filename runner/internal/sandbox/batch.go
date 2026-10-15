package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/DhruvGoyal404/codejudge/runner/internal/boxtar"
	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

// Batch is one run container executing many tests of one submission over the
// framed protocol (docs/PROTOCOL.md). Once a Batch is dead (container exited,
// protocol violation, host guard fired) it is never reused: every later Run
// fails and the container has already been force-removed.
type Batch struct {
	s      *Sandbox
	id     string
	att    client.ContainerAttachResult
	nonce  string // hex, as echoed by judge-exec
	seq    int    // last accepted frame seq (0 = ready)
	lim    Limits
	wall   time.Duration
	frames chan frameOrErr

	ctx    context.Context // bounded by the batch deadline
	cancel context.CancelFunc

	dead      bool
	closeOnce sync.Once
	release   func()
	lang      lang.Lang
	// releaseUID frees the container's uid (after removal).
	releaseUID func()
}

type frameOrErr struct {
	f   protocol.Frame
	err error
}

// validateFrame enforces that a frame belongs to this batch and arrives in
// order: nonce equal to the one generated for this container, seq equal to
// the next expected value.
func validateFrame(f protocol.Frame, nonce string, wantSeq int) error {
	if f.Nonce != nonce {
		return fmt.Errorf("frame nonce %q does not match this batch", f.Nonce)
	}
	if f.Seq != wantSeq {
		return fmt.Errorf("frame seq %d, want %d", f.Seq, wantSeq)
	}
	return nil
}

// StartBatch creates the run container for c, sends the program (only the
// program; no test data) and waits for judge-exec's ready frame. nTests and
// maxInput (largest input) and totalInput (all inputs) size the container's
// deadline and limits.
func (s *Sandbox) StartBatch(ctx context.Context, c *Compiled, lim Limits, nTests, maxInput, totalInput int) (*Batch, error) {
	if lim.OutputBytes <= 0 {
		lim.OutputBytes = DefaultOutputBytes
	}
	if lim.OutputBytes > MaxOutputBytes {
		return nil, fmt.Errorf("output limit %d > %d bytes", lim.OutputBytes, MaxOutputBytes)
	}
	if totalInput < maxInput || totalInput > maxBatchInputBytes {
		return nil, fmt.Errorf("batch inputs total %d bytes outside [%d, %d]", totalInput, maxInput, maxBatchInputBytes)
	}
	if lim.TimeLimit <= 0 || lim.TimeLimit > MaxEffectiveTimeLimit {
		return nil, fmt.Errorf("time limit %v outside (0, %v]", lim.TimeLimit, MaxEffectiveTimeLimit)
	}
	if nTests <= 0 || nTests > MaxTests || maxInput < 0 || maxInput > maxInputBytes {
		return nil, fmt.Errorf("batch of %d tests / %d-byte inputs outside limits", nTests, maxInput)
	}
	image, ok := s.images[c.Lang.RunImage]
	if !ok {
		return nil, fmt.Errorf("image %q not in lock file", c.Lang.RunImage)
	}
	program, err := boxtar.Build(c.Files)
	if err != nil {
		return nil, err
	}
	nonceRaw := make([]byte, protocol.NonceSize)
	if _, err := rand.Read(nonceRaw); err != nil {
		return nil, err
	}

	select {
	case s.sem <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	b := &Batch{s: s, nonce: hex.EncodeToString(nonceRaw), lim: lim, lang: c.Lang, wall: WallLimit(lim.TimeLimit), frames: make(chan frameOrErr, 2)}
	var once sync.Once
	b.release = func() { once.Do(func() { <-s.sem }) }
	b.ctx, b.cancel = context.WithTimeout(ctx, batchDeadline(nTests, lim.TimeLimit, int64(totalInput), lim.OutputBytes))

	memBytes := lim.MemoryMB << 20
	outMB := (lim.OutputBytes + (1<<20 - 1)) >> 20
	progMB := (int64(len(program)) + (1<<20 - 1)) >> 20
	boxMB := progMB + int64(maxInput)>>20 + 2*outMB + 8 // program + input + stdout + stderr + slack
	sp := containerSpec{
		Role: "batch", ImageKey: c.Lang.RunImage, KeepStdinOpen: true,
		// judge-exec keeps a copy of the program tar in memory: add progMB to headroom.
		MemoryBytes: memBytes + (c.Lang.MemOverheadMB+helperHeadroomMB+progMB+boxMB+runTmpMB)<<20,
		NanoCPUs:    runCPUs, PidsLimit: s.pidsLimit() + int64(c.Lang.ExtraTasks), BoxMB: boxMB, TmpMB: runTmpMB,
		Cmd: append([]string{"run", "--batch",
			"--cpu-ms", strconv.FormatInt(lim.TimeLimit.Milliseconds(), 10),
			"--wall-ms", strconv.FormatInt(b.wall.Milliseconds(), 10),
			"--fsize", strconv.FormatInt(lim.OutputBytes, 10),
			"--stack", strconv.FormatInt(memBytes, 10),
			"--nproc", strconv.Itoa(s.nprocLimit() + c.Lang.ExtraTasks),
			"--mem-kb", strconv.FormatInt((lim.MemoryMB+c.Lang.MemOverheadMB)*1024, 10),
			"--stdout-cap", strconv.FormatInt(lim.OutputBytes, 10),
			"--stderr-cap", strconv.Itoa(stderrCap),
			"--max-tar-bytes", strconv.Itoa(len(program)),
			"--max-files", strconv.Itoa(len(c.Files)),
			"--max-input-bytes", strconv.Itoa(maxInput),
			"--"}, lang.Expand(c.Lang.RunCmd, lim.MemoryMB)...),
	}

	fail := func(err error) (*Batch, error) {
		b.Close()
		return nil, err
	}
	id, releaseUID, err := s.createContainer(b.ctx, image, sp)
	if err != nil {
		b.release()
		b.cancel()
		return nil, fmt.Errorf("create: %w", err)
	}
	b.id = id
	b.releaseUID = releaseUID
	b.att, err = s.cli.ContainerAttach(b.ctx, b.id, client.ContainerAttachOptions{Stream: true, Stdin: true, Stdout: true, Stderr: true})
	if err != nil {
		return fail(fmt.Errorf("attach: %w", err))
	}
	if _, err := s.cli.ContainerStart(b.ctx, b.id, client.ContainerStartOptions{}); err != nil {
		return fail(fmt.Errorf("start: %w", err))
	}
	go b.readFrames(maxFrameBytes(lim))

	if err := protocol.WriteMsg(b.att.Conn, protocol.MsgProgram, append(nonceRaw, program...)); err != nil {
		return fail(fmt.Errorf("send program: %w", err))
	}
	select {
	case fe := <-b.frames:
		if fe.err != nil {
			return fail(fmt.Errorf("waiting for ready: %w", fe.err))
		}
		if err := validateFrame(fe.f, b.nonce, 0); err != nil {
			return fail(fmt.Errorf("ready frame: %w", err))
		}
		if fe.f.Status != protocol.StatusReady {
			return fail(fmt.Errorf("judge-exec not ready: %s %s", fe.f.Status, fe.f.Error))
		}
	case <-time.After(hostGrace):
		return fail(errors.New("timed out waiting for ready frame"))
	case <-b.ctx.Done():
		return fail(b.ctx.Err())
	}
	return b, nil
}

func maxFrameBytes(lim Limits) uint32 { return uint32(frameBytes(lim.OutputBytes)) }

// readFrames demultiplexes container stdout and decodes frames until the
// stream ends or breaks. Container stderr (judge-exec diagnostics) is
// discarded after a small cap.
func (b *Batch) readFrames(maxLen uint32) {
	pr, pw := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(pw, &capWriter{max: 16 << 10, discard: true}, b.att.Reader)
		if err == nil {
			err = io.EOF
		}
		pw.CloseWithError(err)
	}()
	for {
		f, err := protocol.ReadFrame(pr, maxLen)
		select {
		case b.frames <- frameOrErr{f, err}:
		case <-b.ctx.Done():
			pr.Close()
			return
		}
		if err != nil {
			pr.Close()
			return
		}
	}
}

// Run sends one test input and returns its classified result. If the
// container dies, violates the protocol, or misses the per-test host guard,
// the result is MLE (container OOM-killed) or IE, and the batch is dead.
func (b *Batch) Run(input []byte) (*Result, error) {
	if b.dead {
		return nil, errors.New("batch container is dead")
	}
	start := time.Now()
	// The guard covers the wall limit, a grace, and moving this input in and
	// the largest possible result frame out.
	guard := b.wall + perTestGrace + transferTime(int64(len(input))+frameBytes(b.lim.OutputBytes))
	_ = b.att.Conn.SetWriteDeadline(time.Now().Add(guard))
	if err := protocol.WriteMsg(b.att.Conn, protocol.MsgTest, input); err != nil {
		// Most likely the container already exited (e.g. OOM): classify as death.
		return b.died(start, fmt.Errorf("send test %d: %w", b.seq+1, err)), nil
	}
	timer := time.NewTimer(guard)
	defer timer.Stop()
	select {
	case fe := <-b.frames:
		if fe.err != nil {
			return b.died(start, fmt.Errorf("test %d: result stream: %w", b.seq+1, fe.err)), nil
		}
		// A genuine judge-exec error frame (right nonce) may carry the seq of
		// the last completed test (e.g. it rejected this test's input before
		// starting it). Report its message; the batch ends either way.
		if fe.f.Nonce == b.nonce && fe.f.Status == protocol.StatusError {
			b.kill()
			return &Result{Status: StatusIE, Reason: "judge-exec: " + fe.f.Error, RunMs: time.Since(start).Milliseconds()}, nil
		}
		if err := validateFrame(fe.f, b.nonce, b.seq+1); err != nil {
			return b.violation(start, err), nil
		}
		b.seq++
		f := fe.f
		res := &Result{RunMs: time.Since(start).Milliseconds()}
		res.Status, res.Reason = classify(runEvidence{frame: &f, limits: b.lim, lang: b.lang})
		fillFromFrame(res, &f)
		return res, nil
	case <-timer.C:
		return b.died(start, fmt.Errorf("test %d: no result within host guard %v", b.seq+1, guard)), nil
	case <-b.ctx.Done():
		return b.died(start, fmt.Errorf("batch deadline: %w", b.ctx.Err())), nil
	}
}

func fillFromFrame(res *Result, f *protocol.Frame) {
	res.ExitCode, res.Signal = f.ExitCode, f.Signal
	res.CPUMs, res.WallMs, res.MaxRSSKB = f.CPUMs, f.WallMs, f.MaxRSSKB
	res.Stdout, res.Stderr = string(f.Stdout), string(f.Stderr)
	res.StdoutBytes, res.StdoutTruncated, res.StderrTruncated = f.StdoutBytes, f.StdoutTruncated, f.StderrTruncated
}

// died handles a container that stopped producing results: wait for it to
// stop, read State.OOMKilled, classify (MLE if OOM-killed, else IE), remove.
func (b *Batch) died(start time.Time, cause error) *Result {
	oom := b.stopAndInspect()
	res := &Result{RunMs: time.Since(start).Milliseconds(), OOMKilled: oom}
	res.Status, res.Reason = classify(runEvidence{oomKilled: oom, hostErr: cause, limits: b.lim, lang: b.lang})
	if !oom {
		res.Reason = cause.Error()
	}
	b.kill()
	return res
}

// violation handles a frame that fails validation: always IE, container removed.
func (b *Batch) violation(start time.Time, cause error) *Result {
	b.kill()
	return &Result{Status: StatusIE, Reason: "protocol violation: " + cause.Error(), RunMs: time.Since(start).Milliseconds()}
}

// stopAndInspect waits briefly for the container to stop (killing it if it
// does not) and reports State.OOMKilled.
func (b *Batch) stopAndInspect() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	wr := b.s.cli.ContainerWait(ctx, b.id, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case <-wr.Result:
	case <-wr.Error:
	case <-time.After(3 * time.Second):
		_, _ = b.s.cli.ContainerKill(ctx, b.id, client.ContainerKillOptions{Signal: "KILL"})
	}
	insp, err := b.s.cli.ContainerInspect(ctx, b.id, client.ContainerInspectOptions{})
	if err != nil || insp.Container.State == nil {
		return false
	}
	return insp.Container.State.OOMKilled
}

// Dead reports whether the batch can no longer run tests.
func (b *Batch) Dead() bool { return b.dead }

// kill marks the batch dead and force-removes the container.
func (b *Batch) kill() {
	b.dead = true
	b.Close()
}

// Close ends the batch: sends E if the container is still healthy, then
// force-removes it and releases the concurrency slot. Safe to call repeatedly.
func (b *Batch) Close() {
	b.closeOnce.Do(func() {
		if !b.dead && b.att.Conn != nil {
			_ = b.att.Conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			_ = protocol.WriteMsg(b.att.Conn, protocol.MsgEnd, nil)
		}
		b.dead = true
		if b.att.Conn != nil {
			b.att.Close()
		}
		if b.id != "" {
			_ = b.s.removeContainer(b.id)
		}
		if b.releaseUID != nil {
			b.releaseUID()
		}
		b.cancel()
		b.release()
	})
}
