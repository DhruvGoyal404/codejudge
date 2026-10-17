package sandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/boxtar"
	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

// Limits are the per-test-case limits a problem sets.
type Limits struct {
	TimeLimit   time.Duration // CPU time
	MemoryMB    int64         // peak RSS of the program
	OutputBytes int64         // max stdout size (RLIMIT_FSIZE); also the returned stdout cap
}

// Fixed sizing. See docs/PHASE1.md "Memory accounting".
const (
	DefaultOutputBytes = 4 << 20
	MaxOutputBytes     = 16 << 20 // largest Limits.OutputBytes accepted

	helperHeadroomMB = 24 // judge-exec (~5 MB RSS) + page cache for the binary/interpreter
	runTmpMB         = 16 // /tmp tmpfs in run containers (charged to the cgroup)
	stderrCap        = 64 << 10
	maxInputBytes    = 16 << 20
	runPids          = 64 // container pids cgroup under runc
	// Under runsc the host pids cgroup counts gVisor's own tasks (Sentry
	// threads, and systrap stub processes per guest address space), not the
	// program's: a guest fork bomb of 32 processes already exceeded 64 host
	// tasks and killed the sandbox (IE). The guest's tasks are limited inside
	// the Sentry by RLIMIT_NPROC (runscNproc); the host cgroup stays as the
	// outer bound on what the sandbox can consume.
	runscPids = 256
	// RLIMIT_NPROC for programs (judge-exec --nproc). It counts every task of
	// the program's uid, judge-exec's own threads included; each container has
	// its own uid (sandboxUser), so the count is per container. It must stay
	// below runPids with headroom for judge-exec, or a thread/fork bomb fills
	// the pids cgroup and judge-exec's Go runtime can't create a thread (IE).
	// Under runsc each guest task also costs host threads in the Sentry, which
	// the pids cgroup counts, so the limit is lower there.
	runcNproc  = 48
	runscNproc = 32
	runCPUs    = 1_000_000_000 // 1 CPU
	hostGrace  = 20 * time.Second

	compileMemoryMB  = 1024
	compileBoxMB     = 128
	compileTmpMB     = 64
	compileCPUMs     = 15_000 // defaults; a language may raise them (lang.Lang.CompileCPUMs/WallMs) up to:
	compileWallMs    = 45_000
	maxCompileCPUMs  = 30_000
	maxCompileWallMs = 60_000
	compileOutCap    = 64 << 20 // compile output tar (static binary + result)
	maxSourceBytes   = 1 << 20
)

// WallLimit is the wall-clock limit judge-exec enforces for a given CPU limit:
// 2x the CPU limit + 1s (programs blocked on sleep/IO still terminate).
func WallLimit(tl time.Duration) time.Duration { return 2*tl + time.Second }

// Result is what judge-run prints.
type Result struct {
	Status          string `json:"status"`
	Reason          string `json:"reason,omitempty"`
	ExitCode        int    `json:"exit_code"`
	Signal          int    `json:"signal"`
	CPUMs           int64  `json:"cpu_ms"`
	WallMs          int64  `json:"wall_ms"`
	MaxRSSKB        int64  `json:"max_rss_kb"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutBytes     int64  `json:"stdout_bytes"`
	StdoutTruncated bool   `json:"stdout_truncated"`
	StderrTruncated bool   `json:"stderr_truncated"`
	OOMKilled       bool   `json:"oom_killed"`
	CompileOutput   string `json:"compile_output,omitempty"`
	CompileMs       int64  `json:"compile_ms"` // host-side, create -> result
	RunMs           int64  `json:"run_ms"`     // host-side, create -> result
}

// Compiled is the output of a successful compile step: the files the run
// step needs (binary for C++, the source itself for Python).
type Compiled struct {
	Lang  lang.Lang
	Files []boxtar.File
}

// Compile runs the language's compile step. On a compilation error it returns
// (nil, *Result with Status CE, nil).
// pidsLimit is the container pids cgroup limit for this sandbox's runtime.
func (s *Sandbox) pidsLimit() int64 {
	if IsGVisor(s.opts.Runtime) {
		return runscPids
	}
	return runPids
}

// nprocLimit is the program's RLIMIT_NPROC for this sandbox's runtime (see runscNproc).
func (s *Sandbox) nprocLimit() int {
	if IsGVisor(s.opts.Runtime) {
		return runscNproc
	}
	return runcNproc
}

// compileLimits are the CPU and wall limits (ms) of l's compile step.
func compileLimits(l lang.Lang) (cpuMs, wallMs int) {
	cpuMs, wallMs = compileCPUMs, compileWallMs
	if l.CompileCPUMs > 0 {
		cpuMs = min(l.CompileCPUMs, maxCompileCPUMs)
	}
	if l.CompileWallMs > 0 {
		wallMs = min(l.CompileWallMs, maxCompileWallMs)
	}
	return cpuMs, wallMs
}

// envFlags turns KEY=VALUE pairs into judge-exec --env flags.
func envFlags(env []string) []string {
	out := make([]string, 0, 2*len(env))
	for _, kv := range env {
		out = append(out, "--env", kv)
	}
	return out
}

func (s *Sandbox) Compile(ctx context.Context, l lang.Lang, src []byte) (*Compiled, *Result, error) {
	if len(src) > maxSourceBytes {
		return nil, &Result{Status: StatusCE, Reason: fmt.Sprintf("source larger than %d bytes", maxSourceBytes)}, nil
	}
	in, err := boxtar.Build([]boxtar.File{{Name: l.Source, Data: src}})
	if err != nil {
		return nil, nil, err
	}
	cpuMs, wallMs := compileLimits(l)
	cmd := []string{"compile",
		"--cpu-ms", strconv.Itoa(cpuMs),
		"--wall-ms", strconv.Itoa(wallMs),
		"--fsize", strconv.Itoa(compileOutCap),
		"--stderr-cap", strconv.Itoa(stderrCap),
		"--max-tar-bytes", strconv.Itoa(maxSourceBytes),
		"--max-files", "1",
		"--nproc", strconv.Itoa(s.nprocLimit() + l.ExtraTasks),
	}
	for _, a := range l.Artifacts {
		cmd = append(cmd, "--artifact", a)
	}
	cmd = append(cmd, envFlags(l.CompileEnv)...)
	cmd = append(append(cmd, "--"), l.CompileCmd...)

	cr, err := s.runContainer(ctx, containerSpec{
		Role: "compile", ImageKey: l.CompileImage, Cmd: cmd,
		MemoryBytes: compileMemoryMB << 20, NanoCPUs: runCPUs, PidsLimit: s.pidsLimit() + int64(l.ExtraTasks),
		BoxMB: compileBoxMB, TmpMB: compileTmpMB,
		StdinTar: in, StdoutCap: compileOutCap + 1<<20,
		Deadline: time.Duration(wallMs)*time.Millisecond + hostGrace,
	})
	res := &Result{CompileMs: cr.Elapsed.Milliseconds()}
	if err != nil {
		res.Status, res.Reason = StatusIE, "compile container: "+err.Error()
		return nil, res, nil
	}
	if cr.DeadlineHit || cr.StdoutCapHit {
		res.Status, res.Reason = StatusIE, fmt.Sprintf("compile container deadline=%v capHit=%v", cr.DeadlineHit, cr.StdoutCapHit)
		return nil, res, nil
	}
	files, err := boxtar.ReadAll(bytes.NewReader(cr.Stdout), boxtar.Limits{MaxBytes: compileOutCap + 1<<20, MaxFiles: 1 + len(l.Artifacts)})
	if err != nil {
		if cr.OOMKilled {
			res.Status, res.Reason = StatusCE, "compiler exceeded its memory limit"
			return nil, res, nil
		}
		res.Status, res.Reason = StatusIE, "compile output: "+err.Error()
		return nil, res, nil
	}
	var f protocol.Frame
	if err := json.Unmarshal(files[protocol.ResultEntry], &f); err != nil {
		res.Status, res.Reason = StatusIE, "compile result frame: "+err.Error()
		return nil, res, nil
	}
	res.CompileOutput = string(f.Stderr)
	switch {
	case f.Status == protocol.StatusError:
		res.Status, res.Reason = StatusIE, "judge-exec: "+f.Error
		return nil, res, nil
	case f.Status == protocol.StatusWallKilled || f.Signal == sigXCPU:
		res.Status, res.Reason = StatusCE, "compilation timed out"
		return nil, res, nil
	case cr.OOMKilled:
		res.Status, res.Reason = StatusCE, "compiler exceeded its memory limit"
		return nil, res, nil
	case f.Status != protocol.StatusExited || f.ExitCode != 0:
		res.Status = StatusCE
		return nil, res, nil
	}

	c := &Compiled{Lang: l}
	if len(l.Artifacts) == 0 {
		c.Files = []boxtar.File{{Name: l.Source, Data: src}}
	}
	for _, a := range l.Artifacts {
		data, ok := files[a]
		if !ok {
			res.Status, res.Reason = StatusIE, "artifact missing from compile output: "+a
			return nil, res, nil
		}
		c.Files = append(c.Files, boxtar.File{Name: a, Mode: 0o755, Data: data})
	}
	return c, res, nil
}

// Run executes a compiled program on one input under lim.
func (s *Sandbox) Run(ctx context.Context, c *Compiled, stdin []byte, lim Limits) (*Result, error) {
	if lim.OutputBytes <= 0 {
		lim.OutputBytes = DefaultOutputBytes
	}
	if lim.OutputBytes > MaxOutputBytes {
		return nil, fmt.Errorf("output limit %d > %d bytes", lim.OutputBytes, MaxOutputBytes)
	}
	if len(stdin) > maxInputBytes {
		return &Result{Status: StatusIE, Reason: "input too large"}, nil
	}
	if lim.TimeLimit <= 0 || lim.TimeLimit > MaxEffectiveTimeLimit {
		return nil, fmt.Errorf("time limit %v outside (0, %v]", lim.TimeLimit, MaxEffectiveTimeLimit)
	}
	files := append(append([]boxtar.File{}, c.Files...), boxtar.File{Name: "input", Data: stdin})
	in, err := boxtar.Build(files)
	if err != nil {
		return nil, err
	}

	wall := WallLimit(lim.TimeLimit)
	memBytes := lim.MemoryMB << 20
	outMB := (lim.OutputBytes + (1<<20 - 1)) >> 20
	boxMB := int64(len(in))>>20 + 2*outMB + 8 // inputs + stdout + stderr files + slack
	containerMem := memBytes + (c.Lang.MemOverheadMB+helperHeadroomMB+boxMB+runTmpMB)<<20

	cmd := []string{"run",
		"--cpu-ms", strconv.FormatInt(lim.TimeLimit.Milliseconds(), 10),
		"--wall-ms", strconv.FormatInt(wall.Milliseconds(), 10),
		"--fsize", strconv.FormatInt(lim.OutputBytes, 10),
		"--stack", strconv.FormatInt(memBytes, 10),
		"--nproc", strconv.Itoa(s.nprocLimit() + c.Lang.ExtraTasks),
		"--mem-kb", strconv.FormatInt((lim.MemoryMB+c.Lang.MemOverheadMB)*1024, 10),
		"--stdout-cap", strconv.FormatInt(lim.OutputBytes, 10),
		"--stderr-cap", strconv.Itoa(stderrCap),
		"--stdin", "input",
		"--max-tar-bytes", strconv.Itoa(len(in)),
		"--max-files", strconv.Itoa(len(files)),
	}
	cmd = append(cmd, envFlags(lang.Expand(c.Lang.RunEnv, lim.MemoryMB))...)
	cmd = append(append(cmd, "--"), lang.Expand(c.Lang.RunCmd, lim.MemoryMB)...)

	cr, cerr := s.runContainer(ctx, containerSpec{
		Role: "run", ImageKey: c.Lang.RunImage, Cmd: cmd,
		MemoryBytes: containerMem, NanoCPUs: runCPUs, PidsLimit: s.pidsLimit() + int64(c.Lang.ExtraTasks),
		BoxMB: boxMB, TmpMB: runTmpMB,
		StdinTar: in,
		// Frame = base64(stdout + stderr) + small JSON envelope.
		StdoutCap: (lim.OutputBytes+stderrCap)*4/3 + 64<<10,
		Deadline:  wall + hostGrace,
	})

	ev := runEvidence{limits: lim, lang: c.Lang, oomKilled: cr.OOMKilled, hostDeadline: cr.DeadlineHit, hostErr: cerr}
	if cr.StdoutCapHit && cerr == nil {
		ev.hostErr = fmt.Errorf("result frame exceeded %d bytes", (lim.OutputBytes+stderrCap)*4/3+64<<10)
	}
	var f protocol.Frame
	if cerr == nil && !cr.StdoutCapHit && len(bytes.TrimSpace(cr.Stdout)) > 0 {
		if err := json.Unmarshal(bytes.TrimSpace(cr.Stdout), &f); err == nil {
			ev.frame = &f
		} else {
			ev.hostErr = fmt.Errorf("parse result frame: %w", err)
		}
	}
	res := &Result{RunMs: cr.Elapsed.Milliseconds(), OOMKilled: cr.OOMKilled}
	res.Status, res.Reason = classify(ev)
	if ev.frame != nil {
		res.ExitCode, res.Signal = f.ExitCode, f.Signal
		res.CPUMs, res.WallMs, res.MaxRSSKB = f.CPUMs, f.WallMs, f.MaxRSSKB
		res.Stdout, res.Stderr = string(f.Stdout), string(f.Stderr)
		res.StdoutBytes, res.StdoutTruncated, res.StderrTruncated = f.StdoutBytes, f.StdoutTruncated, f.StderrTruncated
	}
	return res, nil
}

// Execute compiles then runs once: what judge-run does.
func (s *Sandbox) Execute(ctx context.Context, l lang.Lang, src, stdin []byte, lim Limits) (*Result, error) {
	c, cres, err := s.Compile(ctx, l, src)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return cres, nil
	}
	res, err := s.Run(ctx, c, stdin, lim)
	if err != nil {
		return nil, err
	}
	res.CompileMs = cres.CompileMs
	res.CompileOutput = cres.CompileOutput
	return res, nil
}
