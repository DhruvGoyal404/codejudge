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
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

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

type options struct {
	mode        string
	maxTarBytes int64
	maxFiles    int
	cpuMs       int64 // RLIMIT_CPU is set to ceil(cpuMs/1000)+1 seconds; 0 = unlimited
	wallMs      int64
	fsize       int64 // RLIMIT_FSIZE bytes; 0 = unlimited
	stack       int64 // RLIMIT_STACK bytes; 0 = inherit
	memKB       int64 // kill when peak RSS (VmHWM) exceeds this; 0 = off
	stdoutCap   int64
	stderrCap   int64
	stdinFile   string
	artifacts   []string
	cmd         []string
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

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
	fs.Int64Var(&o.memKB, "mem-kb", 0, "")
	fs.Int64Var(&o.stdoutCap, "stdout-cap", 64<<10, "")
	fs.Int64Var(&o.stderrCap, "stderr-cap", 64<<10, "")
	fs.StringVar(&o.stdinFile, "stdin", "", "")
	var arts multiFlag
	fs.Var(&arts, "artifact", "")
	if err := fs.Parse(args[1:]); err != nil {
		return o, err
	}
	o.artifacts = arts
	o.cmd = fs.Args()
	if len(o.cmd) == 0 {
		return o, errors.New("missing command after --")
	}
	if o.wallMs <= 0 {
		return o, errors.New("--wall-ms must be > 0")
	}
	return o, nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "__child" {
		childMain(os.Args[2:])
		return
	}
	o, err := parse(os.Args[1:])
	if err != nil {
		emit(o, protocol.Frame{Mode: o.mode, Status: protocol.StatusError, Error: "args: " + err.Error()})
		os.Exit(2)
	}
	if err := boxtar.Extract(os.Stdin, boxDir, boxtar.Limits{MaxBytes: o.maxTarBytes, MaxFiles: o.maxFiles}); err != nil {
		emit(o, protocol.Frame{Mode: o.mode, Status: protocol.StatusError, Error: "input: " + err.Error()})
		os.Exit(2)
	}
	f := execute(o)
	emit(o, f)
}

// childMain runs in the re-executed child: apply rlimits, then exec the
// program. rlimits are process-wide, so setting them here (before exec) is
// safe even though the Go runtime is multi-threaded.
//
//	__child CPU_SEC FSIZE STACK -- CMD...
func childMain(args []string) {
	if len(args) < 5 || args[3] != "--" {
		fmt.Fprintln(os.Stderr, "judge-exec: bad __child args")
		os.Exit(127)
	}
	cpuSec, _ := strconv.ParseUint(args[0], 10, 64)
	fsize, _ := strconv.ParseUint(args[1], 10, 64)
	stack, _ := strconv.ParseUint(args[2], 10, 64)
	cmd := args[4:]

	set := func(res int, cur, max uint64) {
		if err := syscall.Setrlimit(res, &syscall.Rlimit{Cur: cur, Max: max}); err != nil {
			fmt.Fprintf(os.Stderr, "judge-exec: setrlimit(%d): %v\n", res, err)
			os.Exit(127)
		}
	}
	set(syscall.RLIMIT_CORE, 0, 0)
	if cpuSec > 0 {
		set(syscall.RLIMIT_CPU, cpuSec, cpuSec+1) // SIGXCPU at soft, SIGKILL at hard
	}
	if fsize > 0 {
		set(syscall.RLIMIT_FSIZE, fsize, fsize)
	}
	if stack > 0 {
		set(syscall.RLIMIT_STACK, stack, stack)
	}

	path := cmd[0]
	if !strings.Contains(path, "/") {
		path = lookPath(path)
	}
	err := syscall.Exec(path, cmd, childEnv)
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

func execute(o options) protocol.Frame {
	f := protocol.Frame{Mode: o.mode}
	fail := func(err error) protocol.Frame {
		f.Status = protocol.StatusError
		f.Error = err.Error()
		return f
	}

	stdinPath := os.DevNull
	if o.mode == "run" && o.stdinFile != "" {
		stdinPath = filepath.Join(boxDir, o.stdinFile)
		if _, err := os.Stat(stdinPath); err != nil {
			stdinPath = os.DevNull
		}
	}
	stdoutPath := filepath.Join(boxDir, ".stdout")
	stderrPath := filepath.Join(boxDir, ".stderr")
	if o.mode == "compile" {
		stdoutPath = filepath.Join(boxDir, ".compile.log")
		stderrPath = stdoutPath
	}
	in, err := os.Open(stdinPath)
	if err != nil {
		return fail(err)
	}
	defer in.Close()
	out, err := os.OpenFile(stdoutPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fail(err)
	}
	defer out.Close()
	errf := out
	if stderrPath != stdoutPath {
		errf, err = os.OpenFile(stderrPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return fail(err)
		}
		defer errf.Close()
	}

	self, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	var cpuSec int64
	if o.cpuMs > 0 {
		cpuSec = (o.cpuMs+999)/1000 + 1 // time limit rounded up, +1s
	}
	argv := append([]string{"judge-exec", "__child",
		strconv.FormatInt(cpuSec, 10), strconv.FormatInt(o.fsize, 10), strconv.FormatInt(o.stack, 10), "--"}, o.cmd...)

	start := time.Now()
	pid, err := syscall.ForkExec(self, argv, &syscall.ProcAttr{
		Dir:   boxDir,
		Env:   childEnv,
		Files: []uintptr{in.Fd(), out.Fd(), errf.Fd()},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	if err != nil {
		return fail(fmt.Errorf("start: %w", err))
	}

	type waitResult struct {
		ws  syscall.WaitStatus
		ru  syscall.Rusage
		err error
	}
	done := make(chan waitResult, 1)
	go func() {
		var r waitResult
		for {
			_, r.err = syscall.Wait4(pid, &r.ws, 0, &r.ru)
			if r.err != syscall.EINTR {
				break
			}
		}
		done <- r
	}()

	wall := time.NewTimer(time.Duration(o.wallMs) * time.Millisecond)
	defer wall.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	var wallKilled, memKilled bool
	var peakSeenKB int64
	var res waitResult
loop:
	for {
		select {
		case res = <-done:
			break loop
		case <-wall.C:
			wallKilled = true
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		case <-poll.C:
			if o.memKB > 0 && !memKilled {
				if hwm := readHWM(pid); hwm > peakSeenKB {
					peakSeenKB = hwm
					if hwm > o.memKB {
						memKilled = true
						_ = syscall.Kill(-pid, syscall.SIGKILL)
					}
				}
			}
		}
	}
	f.WallMs = time.Since(start).Milliseconds()

	killAll(pid)

	if res.err != nil {
		return fail(fmt.Errorf("wait4: %w", res.err))
	}
	f.CPUMs = tvMs(res.ru.Utime) + tvMs(res.ru.Stime)
	f.MaxRSSKB = res.ru.Maxrss // kilobytes on Linux
	if peakSeenKB > f.MaxRSSKB {
		f.MaxRSSKB = peakSeenKB
	}
	switch {
	case res.ws.Exited():
		f.Status = protocol.StatusExited
		f.ExitCode = res.ws.ExitStatus()
	case res.ws.Signaled():
		f.Status = protocol.StatusSignaled
		f.Signal = int(res.ws.Signal())
	}
	if wallKilled {
		f.Status = protocol.StatusWallKilled
	} else if memKilled {
		f.Status = protocol.StatusMemKilled
	}

	if o.mode == "compile" {
		f.Stderr, f.StderrTruncated, _ = readCapped(stdoutPath, o.stderrCap)
		if f.Status == protocol.StatusExited && f.ExitCode == 0 {
			for _, a := range o.artifacts {
				if st, err := os.Stat(filepath.Join(boxDir, a)); err != nil || !st.Mode().IsRegular() {
					return fail(fmt.Errorf("artifact %q missing after successful compile", a))
				}
			}
			f.Artifacts = o.artifacts
		}
		return f
	}

	var size int64
	f.Stdout, f.StdoutTruncated, size = readCapped(stdoutPath, o.stdoutCap)
	f.StdoutBytes = size
	f.Stderr, f.StderrTruncated, _ = readCapped(stderrPath, o.stderrCap)
	f.OutputLimitHit = (o.fsize > 0 && size >= o.fsize) || f.Signal == int(syscall.SIGXFSZ)
	return f
}

// killAll removes every process other than judge-exec and reaps them before
// returning. As PID 1, kill(-1, SIGKILL) reaches every process in the
// container's PID namespace (all run as the same uid). Outside PID 1 (local
// debugging) it only kills the program's process group.
func killAll(pgid int) {
	pid1 := os.Getpid() == 1
	kill := func() {
		if pid1 {
			_ = syscall.Kill(-1, syscall.SIGKILL)
		} else {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}
	kill()
	deadline := time.Now().Add(3 * time.Second)
	for {
		wpid, err := syscall.Wait4(-1, nil, syscall.WNOHANG, nil)
		if err == syscall.ECHILD {
			return
		}
		if err == syscall.EINTR || wpid > 0 {
			continue
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(time.Millisecond)
		kill() // catch anything forked between the first kill and now
	}
}

func readHWM(pid int) int64 {
	fh, err := os.Open("/proc/" + strconv.Itoa(pid) + "/status")
	if err != nil {
		return 0
	}
	defer fh.Close()
	sc := bufio.NewScanner(fh)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "VmHWM:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				v, _ := strconv.ParseInt(fields[1], 10, 64)
				return v
			}
		}
	}
	return 0
}

func tvMs(tv syscall.Timeval) int64 { return tv.Sec*1000 + int64(tv.Usec)/1000 }

// readCapped returns at most capBytes of the file, whether it was truncated,
// and the file's full size. Never reads more than capBytes into memory.
func readCapped(p string, capBytes int64) ([]byte, bool, int64) {
	fh, err := os.Open(p)
	if err != nil {
		return nil, false, 0
	}
	defer fh.Close()
	var size int64
	if st, err := fh.Stat(); err == nil {
		size = st.Size()
	}
	data, _ := io.ReadAll(io.LimitReader(fh, capBytes))
	return data, size > capBytes, size
}

func emit(o options, f protocol.Frame) {
	if o.mode != "compile" {
		_ = json.NewEncoder(os.Stdout).Encode(f)
		return
	}
	// compile: tar with result.json first, then artifacts.
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(f)
	tw := tar.NewWriter(os.Stdout)
	_ = tw.WriteHeader(&tar.Header{Name: protocol.ResultEntry, Mode: 0o644, Size: int64(buf.Len()), Typeflag: tar.TypeReg})
	_, _ = tw.Write(buf.Bytes())
	for _, a := range f.Artifacts {
		p := filepath.Join(boxDir, a)
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		fh, err := os.Open(p)
		if err != nil {
			continue
		}
		_ = tw.WriteHeader(&tar.Header{Name: a, Mode: int64(st.Mode().Perm()), Size: st.Size(), Typeflag: tar.TypeReg})
		_, _ = io.Copy(tw, fh)
		fh.Close()
	}
	_ = tw.Close()
}
