//go:build linux

// Command judge-exec is PID 1 inside every sandbox container.
//
//	judge-exec compile [flags] -- CMD ARGS...   (emits a tar: result.json + artifacts)
//	judge-exec run     [flags] -- CMD ARGS...   (emits one JSON protocol.Frame)
//
// It reads a tar stream from stdin into /box, runs CMD in its own process
// group with rlimits applied, enforces a wall-clock limit and an optional
// peak-RSS limit, then SIGKILLs every other process in the container, reaps
// them, and only then writes its result to stdout.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/DhruvGoyal404/codejudge/runner/internal/boxtar"
	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

const boxDir = "/box"

// Environment for the judged program. Fixed and minimal; nothing from the
// container's own environment leaks through.
var childEnv = []string{
	"PATH=/usr/local/bin:/usr/bin:/bin",
	"HOME=/tmp",
	"TMPDIR=/tmp",
	"LANG=C.UTF-8",
	"PYTHONDONTWRITEBYTECODE=1",
	"PYTHONUNBUFFERED=1",
}

func parse(args []string) (options, error) {
	var o options
	if len(args) == 0 {
		return o, errors.New("usage: judge-exec compile|run [flags] -- CMD...")
	}
	o.mode = args[0]
	if o.mode != "compile" && o.mode != "run" {
		return o, fmt.Errorf("unknown mode %q", o.mode)
	}
	fs := flag.NewFlagSet(o.mode, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Int64Var(&o.maxTarBytes, "max-tar-bytes", 32<<20, "")
	fs.IntVar(&o.maxFiles, "max-files", 16, "")
	fs.Int64Var(&o.cpuMs, "cpu-ms", 0, "")
	fs.Int64Var(&o.wallMs, "wall-ms", 10000, "")
	fs.Int64Var(&o.fsize, "fsize", 0, "")
	fs.Int64Var(&o.stack, "stack", 0, "")
	fs.Int64Var(&o.nproc, "nproc", 0, "")
	fs.Int64Var(&o.memKB, "mem-kb", 0, "")
	fs.Int64Var(&o.stdoutCap, "stdout-cap", 64<<10, "")
	fs.Int64Var(&o.stderrCap, "stderr-cap", 64<<10, "")
	fs.StringVar(&o.stdinFile, "stdin", "", "")
	fs.BoolVar(&o.batch, "batch", false, "")
	fs.Int64Var(&o.maxInput, "max-input-bytes", 16<<20, "")
	var arts, env multiFlag
	fs.Var(&arts, "artifact", "")
	fs.Var(&env, "env", "")
	if err := fs.Parse(args[1:]); err != nil {
		return o, err
	}
	o.artifacts = arts
	for _, kv := range env {
		if !envVarRE.MatchString(kv) {
			return o, fmt.Errorf("bad --env %q (want KEY=VALUE, KEY in [A-Z0-9_])", kv)
		}
	}
	o.env = env
	o.cmd = fs.Args()
	if len(o.cmd) == 0 {
		return o, errors.New("missing command after --")
	}
	if o.wallMs <= 0 {
		return o, errors.New("--wall-ms must be > 0")
	}
	if o.batch && o.mode != "run" {
		return o, errors.New("--batch is only valid in run mode")
	}
	if o.maxInput < 0 || o.maxInput > 1<<30 || o.maxTarBytes < 0 || o.maxTarBytes > 1<<30 {
		return o, errors.New("size limits out of range")
	}
	return o, nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "__child" {
		childMain(os.Args[2:])
		return
	}
	harden()
	o, err := parse(os.Args[1:])
	if err != nil {
		_ = emitResult(os.Stdout, protocol.Frame{Mode: o.mode, Status: protocol.StatusError, Error: "args: " + err.Error()})
		os.Exit(2)
	}
	if o.batch {
		os.Exit(runBatch(o, realBatchDeps(o)))
	}
	if err := boxtar.Extract(os.Stdin, boxDir, boxtar.Limits{MaxBytes: o.maxTarBytes, MaxFiles: o.maxFiles}); err != nil {
		_ = emitResult(os.Stdout, protocol.Frame{Mode: o.mode, Status: protocol.StatusError, Error: "input: " + err.Error()})
		os.Exit(2)
	}
	inputPath := ""
	if o.mode == "run" && o.stdinFile != "" {
		inputPath = filepath.Join(boxDir, o.stdinFile)
	}
	f := runOne(o, inputPath)
	_ = emitResult(os.Stdout, f)
}

// harden protects judge-exec (PID 1) from the program it supervises, which
// runs as the same uid:
//   - PR_SET_DUMPABLE=0 makes /proc/1/* (fd, mem, environ, ...) root-owned and
//     denies ptrace/process_vm_* access to non-CAP_SYS_PTRACE processes, so a
//     program cannot write forged frames into our stdout via /proc/1/fd/1 or
//     tamper with our memory. execve resets dumpable for the re-exec child and
//     the program, so measurements via /proc/<child>/status still work.
//   - Catching and dropping terminating signals: in a PID namespace the kernel
//     only delivers signals to init for which a handler is installed, and the
//     Go runtime installs exit-on-signal handlers by default. A handler (not
//     SIG_IGN) is used so children get default dispositions after execve.
func harden() {
	const prSetDumpable = 4
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); errno != 0 {
		fmt.Fprintln(os.Stderr, "judge-exec: prctl(PR_SET_DUMPABLE, 0):", errno)
		os.Exit(3)
	}
	ch := make(chan os.Signal, 16)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT,
		syscall.SIGUSR1, syscall.SIGUSR2, syscall.SIGALRM, syscall.SIGVTALRM, syscall.SIGPROF)
	go func() {
		for range ch {
		}
	}()
}

// childMain runs in the re-executed child: apply rlimits, then exec the
// program. rlimits are process-wide, so setting them here (before exec) is
// safe even though the Go runtime is multi-threaded.
//
//	__child CPU_SEC FSIZE STACK NPROC -- CMD...
//
// rlimitNPROC is RLIMIT_NPROC on Linux (x86-64 and arm64); the syscall
// package does not export it.
const rlimitNPROC = 6

func childMain(args []string) {
	if len(args) < 6 || args[4] != "--" {
		fmt.Fprintln(os.Stderr, "judge-exec: bad __child args")
		os.Exit(127)
	}
	cpuSec, _ := strconv.ParseUint(args[0], 10, 64)
	fsize, _ := strconv.ParseUint(args[1], 10, 64)
	stack, _ := strconv.ParseUint(args[2], 10, 64)
	nproc, _ := strconv.ParseUint(args[3], 10, 64)
	cmd := args[5:]

	set := func(res int, cur, max uint64) {
		if err := syscall.Setrlimit(res, &syscall.Rlimit{Cur: cur, Max: max}); err != nil {
			fmt.Fprintf(os.Stderr, "judge-exec: setrlimit(%d): %v\n", res, err)
			os.Exit(127)
		}
	}
	// RLIMIT_CORE=1, not 0: when the host's core_pattern pipes to a helper
	// (WSL2, apport, systemd-coredump) the kernel ignores a limit of 0 and
	// still runs the dump, which makes a crashing multithreaded program hang
	// for seconds (seen as TLE instead of RE). A limit of 1 makes the kernel
	// refuse pipe dumps, and 1 byte is below any file dump's minimum.
	set(syscall.RLIMIT_CORE, 1, 1)
	if cpuSec > 0 {
		set(syscall.RLIMIT_CPU, cpuSec, cpuSec+1) // SIGXCPU at soft, SIGKILL at hard
	}
	if fsize > 0 {
		set(syscall.RLIMIT_FSIZE, fsize, fsize)
	}
	if stack > 0 {
		set(syscall.RLIMIT_STACK, stack, stack)
	}
	if nproc > 0 {
		// Process/thread limit for the program: fork/clone fail with EAGAIN at
		// the limit, so a fork bomb can't exhaust the container's tasks and
		// take judge-exec (or, under gVisor, the Sentry) down with it. The
		// container's pids limit stays as the outer layer.
		set(rlimitNPROC, nproc, nproc)
	}

	path := cmd[0]
	if !strings.Contains(path, "/") {
		path = lookPath(path)
	}
	// The environment arrives from runOne (programEnv), already final.
	err := syscall.Exec(path, cmd, os.Environ())
	fmt.Fprintf(os.Stderr, "judge-exec: exec %s: %v\n", cmd[0], err)
	os.Exit(127)
}

func lookPath(name string) string {
	for _, dir := range []string{"/usr/local/bin", "/usr/bin", "/bin"} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p
		}
	}
	return name
}
