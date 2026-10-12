// Package sandbox runs untrusted programs in locked-down, single-use Docker
// containers. See CLAUDE.md "Sandbox invariants" — every container created
// here satisfies all of them.
package sandbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

// LabelManaged marks every container (and image) this project creates.
const LabelManaged = "judge.managed"

// sandboxUser is "nobody:nogroup"; containers never run as root.
const sandboxUser = "65534:65534"

// Options configures a Sandbox.
type Options struct {
	SeccompPath    string // sandbox/seccomp/default.json
	ImagesLockPath string // sandbox/images/images.lock.json
	Concurrency    int    // max containers in flight; default 2
}

// Sandbox owns a Docker client, the pinned images, the seccomp profile and
// the concurrency semaphore.
type Sandbox struct {
	cli     *client.Client
	seccomp string            // compacted JSON, inlined into SecurityOpt as the CLI does
	images  map[string]string // lock key -> image ID (sha256:...)
	sem     chan struct{}
	opts    Options
}

// New connects to Docker (API version negotiated; verified against engine
// 27.0.3 / API 1.46), loads the seccomp profile and image lock, and runs the
// startup reaper.
func New(ctx context.Context, o Options) (*Sandbox, error) {
	if o.Concurrency <= 0 {
		o.Concurrency = 2
	}
	raw, err := os.ReadFile(o.SeccompPath)
	if err != nil {
		return nil, fmt.Errorf("read seccomp profile: %w", err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, fmt.Errorf("seccomp profile is not valid JSON: %w", err)
	}
	lockRaw, err := os.ReadFile(o.ImagesLockPath)
	if err != nil {
		return nil, fmt.Errorf("read image lock (run scripts/build-images.ps1): %w", err)
	}
	images := map[string]string{}
	if err := json.Unmarshal(lockRaw, &images); err != nil {
		return nil, fmt.Errorf("parse image lock: %w", err)
	}
	cli, err := client.New(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	if _, err := cli.Ping(ctx, client.PingOptions{NegotiateAPIVersion: true}); err != nil {
		cli.Close()
		return nil, fmt.Errorf("docker ping: %w", err)
	}
	s := &Sandbox{cli: cli, seccomp: compact.String(), images: images, sem: make(chan struct{}, o.Concurrency), opts: o}
	if _, err := s.Reap(ctx); err != nil {
		cli.Close()
		return nil, fmt.Errorf("startup reaper: %w", err)
	}
	return s, nil
}

// Close releases the Docker client.
func (s *Sandbox) Close() error { return s.cli.Close() }

// APIVersion reports the negotiated Docker API version.
func (s *Sandbox) APIVersion() string { return s.cli.ClientVersion() }

// Reap force-removes stale judge.managed containers: those whose owning
// runner instance is dead (judge.instance/judge.pid/judge.pid_start labels,
// pid liveness + start time to defeat pid reuse), and any older than
// ReaperThreshold, which exceeds MaxContainerLifetime. Containers of live
// instances (including this one) are never touched, so concurrent runner
// processes cannot destroy each other's work, and a container that has just
// exited is not removed before its owner reads State.OOMKilled.
func (s *Sandbox) Reap(ctx context.Context) (int, error) {
	list, err := s.cli.ContainerList(ctx, client.ContainerListOptions{
		All:     true,
		Filters: make(client.Filters).Add("label", LabelManaged+"=true"),
	})
	if err != nil {
		return 0, err
	}
	n := 0
	cutoff := time.Now().Add(-ReaperThreshold).Unix()
	for _, c := range list.Items {
		if c.Labels[LabelManaged] != "true" {
			continue // defensive: never touch anything not ours
		}
		if c.Labels[LabelInstance] == self.ID {
			continue
		}
		if !ownerDead(c.Labels) && c.Created > cutoff {
			continue
		}
		if _, err := s.cli.ContainerRemove(ctx, c.ID, client.ContainerRemoveOptions{Force: true}); err == nil {
			n++
		}
	}
	return n, nil
}

// ManagedContainers counts judge.managed containers (any state).
func (s *Sandbox) ManagedContainers(ctx context.Context) (int, error) {
	list, err := s.cli.ContainerList(ctx, client.ContainerListOptions{
		All:     true,
		Filters: make(client.Filters).Add("label", LabelManaged+"=true"),
	})
	if err != nil {
		return 0, err
	}
	return len(list.Items), nil
}

// containerSpec is one single-use container run.
type containerSpec struct {
	Role        string // "compile" | "run" (label only)
	ImageKey    string
	Cmd         []string
	MemoryBytes int64 // memory == memory-swap (no swap)
	NanoCPUs    int64
	PidsLimit   int64
	BoxMB       int64 // /box tmpfs (exec)
	TmpMB       int64 // /tmp tmpfs (noexec)
	StdinTar    []byte
	StdoutCap   int64         // hard cap on bytes read from container stdout
	Deadline    time.Duration // outer deadline: create -> result
}

func (sp containerSpec) labels() map[string]string {
	l := self.labels()
	l[LabelManaged] = "true"
	l["judge.role"] = sp.Role
	return l
}

type containerResult struct {
	Stdout       []byte
	StdoutCapHit bool // container wrote more than StdoutCap; it was killed
	Stderr       []byte
	ExitCode     int64
	OOMKilled    bool
	DeadlineHit  bool
	Elapsed      time.Duration
}

var errCapExceeded = errors.New("output cap exceeded")

// capWriter buffers up to max bytes and fails once the cap is exceeded.
type capWriter struct {
	buf     bytes.Buffer
	max     int64
	discard bool // if true, silently drop overflow instead of failing
	hit     bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	room := w.max - int64(w.buf.Len())
	if int64(len(p)) <= room {
		return w.buf.Write(p)
	}
	if room > 0 {
		w.buf.Write(p[:room])
	}
	w.hit = true
	if w.discard {
		return len(p), nil
	}
	return int(max(room, 0)), errCapExceeded
}

func randName() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "judge-" + hex.EncodeToString(b)
}

// runContainer creates, attaches, starts, feeds and drains one container,
// and always force-removes it before returning — on success, error,
// deadline, and panic.
func (s *Sandbox) runContainer(ctx context.Context, sp containerSpec) (res containerResult, err error) {
	select {
	case s.sem <- struct{}{}:
	case <-ctx.Done():
		return res, ctx.Err()
	}
	defer func() { <-s.sem }()

	image, ok := s.images[sp.ImageKey]
	if !ok {
		return res, fmt.Errorf("image %q not in lock file (run scripts/build-images.ps1)", sp.ImageKey)
	}
	start := time.Now()
	dctx, cancel := context.WithTimeout(ctx, sp.Deadline)
	defer cancel()

	pids := sp.PidsLimit
	cfg := &container.Config{
		Image:           image,
		Cmd:             sp.Cmd,
		User:            sandboxUser,
		WorkingDir:      "/box",
		AttachStdin:     true,
		AttachStdout:    true,
		AttachStderr:    true,
		OpenStdin:       true,
		StdinOnce:       true,
		NetworkDisabled: true,
		Labels:          sp.labels(),
	}
	hc := &container.HostConfig{
		NetworkMode:    "none",
		ReadonlyRootfs: true,
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges", "seccomp=" + s.seccomp},
		LogConfig:      container.LogConfig{Type: "none"},
		Tmpfs: map[string]string{
			"/box": fmt.Sprintf("rw,exec,nosuid,nodev,size=%dm,mode=1777", sp.BoxMB),
			"/tmp": fmt.Sprintf("rw,noexec,nosuid,nodev,size=%dm,mode=1777", sp.TmpMB),
		},
		Resources: container.Resources{
			Memory:     sp.MemoryBytes,
			MemorySwap: sp.MemoryBytes,
			NanoCPUs:   sp.NanoCPUs,
			PidsLimit:  &pids,
			Ulimits:    []*container.Ulimit{{Name: "nofile", Soft: 256, Hard: 256}},
		},
	}

	created, err := s.cli.ContainerCreate(dctx, client.ContainerCreateOptions{Name: randName(), Config: cfg, HostConfig: hc})
	if err != nil {
		return res, fmt.Errorf("create: %w", err)
	}
	id := created.ID
	defer func() {
		// Fresh context: must run even if ctx/dctx are cancelled or we panicked.
		rctx, rcancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer rcancel()
		if _, rerr := s.cli.ContainerRemove(rctx, id, client.ContainerRemoveOptions{Force: true}); rerr != nil && err == nil {
			err = fmt.Errorf("remove %s: %w", id[:12], rerr)
		}
	}()

	att, err := s.cli.ContainerAttach(dctx, id, client.ContainerAttachOptions{Stream: true, Stdin: true, Stdout: true, Stderr: true})
	if err != nil {
		return res, fmt.Errorf("attach: %w", err)
	}
	defer att.Close()

	if _, err := s.cli.ContainerStart(dctx, id, client.ContainerStartOptions{}); err != nil {
		return res, fmt.Errorf("start: %w", err)
	}

	go func() {
		_, _ = att.Conn.Write(sp.StdinTar)
		_ = att.CloseWrite() // EOF on container stdin (StdinOnce)
	}()

	stdout := &capWriter{max: sp.StdoutCap}
	stderr := &capWriter{max: 16 << 10, discard: true}
	readDone := make(chan error, 1)
	go func() {
		_, rerr := stdcopy.StdCopy(stdout, stderr, att.Reader)
		readDone <- rerr
	}()

	killNow := func() {
		kctx, kcancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer kcancel()
		_, _ = s.cli.ContainerKill(kctx, id, client.ContainerKillOptions{Signal: "KILL"})
		att.Close()
	}

	select {
	case rerr := <-readDone:
		if errors.Is(rerr, errCapExceeded) {
			res.StdoutCapHit = true
			killNow()
		}
	case <-dctx.Done():
		res.DeadlineHit = true
		killNow()
		<-readDone
	}
	res.Stdout = stdout.buf.Bytes()
	res.Stderr = stderr.buf.Bytes()

	// Wait for the container to stop, then read OOMKilled/exit code before the
	// deferred removal.
	wctx, wcancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer wcancel()
	wr := s.cli.ContainerWait(wctx, id, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case r := <-wr.Result:
		res.ExitCode = r.StatusCode
	case werr := <-wr.Error:
		if !res.DeadlineHit && !res.StdoutCapHit {
			return res, fmt.Errorf("wait: %w", werr)
		}
	}
	insp, err := s.cli.ContainerInspect(wctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return res, fmt.Errorf("inspect: %w", err)
	}
	if insp.Container.State != nil {
		res.OOMKilled = insp.Container.State.OOMKilled
		res.ExitCode = int64(insp.Container.State.ExitCode)
	}
	res.Elapsed = time.Since(start)
	return res, nil
}

// FindRepoFile walks up from the working directory and from the executable's
// directory looking for rel (slash-separated), e.g. "sandbox/seccomp/default.json".
func FindRepoFile(rel string) (string, error) {
	var starts []string
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, dir := range starts {
		for d := dir; ; d = filepath.Dir(d) {
			p := filepath.Join(d, filepath.FromSlash(rel))
			if _, err := os.Stat(p); err == nil {
				return p, nil
			}
			if filepath.Dir(d) == d {
				break
			}
		}
	}
	return "", fmt.Errorf("%s not found above %v", rel, starts)
}
