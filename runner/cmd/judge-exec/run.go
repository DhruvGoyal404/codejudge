//go:build linux

package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

// runOne runs the program once with stdin from inputPath ("" or missing ->
// /dev/null), enforces limits, kills and reaps every other process, and
// returns the result. Moved unchanged from main.go (was execute).
func runOne(o RunConfig, inputPath string) Result {
	f := Result{Mode: o.mode}
	fail := func(err error) Result {
		f.Status = protocol.StatusError
		f.Error = err.Error()
		return f
	}

	stdinPath := os.DevNull
	if inputPath != "" {
		stdinPath = inputPath
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
		strconv.FormatInt(cpuSec, 10), strconv.FormatInt(o.fsize, 10), strconv.FormatInt(o.stack, 10), strconv.FormatInt(o.nproc, 10), "--"}, o.cmd...)

	start := time.Now()
	pid, err := syscall.ForkExec(self, argv, &syscall.ProcAttr{
		Dir:   boxDir,
		Env:   programEnv(childEnv, o.env),
		Files: []uintptr{in.Fd(), out.Fd(), errf.Fd()},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	if err != nil {
		return fail(fmt.Errorf("start: %w", err))
	}
	lastPgid = pid

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
	var wallKilled, memKilled, outKilled bool
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
			// Output limit: stop the program as soon as stdout reaches the cap.
			// RLIMIT_FSIZE alone isn't enough: runtimes that ignore SIGXFSZ (the
			// JVM) or buffer failed writes (Node) would spin into TLE or grow
			// into MLE instead of reporting OLE.
			if o.mode != "compile" && o.fsize > 0 && !outKilled {
				if st, err := out.Stat(); err == nil && st.Size() >= o.fsize {
					outKilled = true
					_ = syscall.Kill(-pid, syscall.SIGKILL)
				}
			}
		}
	}
	f.WallMs = time.Since(start).Milliseconds()

	reapAll()

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
	f.OutputLimitHit = outKilled || (o.fsize > 0 && size >= o.fsize) || f.Signal == int(syscall.SIGXFSZ)
	return f
}

// lastPgid is the process group of the most recent program; used by reapAll
// only when judge-exec is not PID 1 (local debugging).
var lastPgid int

// reapAll removes every process other than judge-exec and reaps them before
// returning. As PID 1, kill(-1, SIGKILL) reaches every process in the
// container's PID namespace (all run as the same uid). Outside PID 1 (local
// debugging) it only kills the last program's process group. Idempotent:
// with nothing left it returns at once (ECHILD). Moved unchanged (was killAll).
func reapAll() {
	pgid := lastPgid
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

// emitResult writes r: one JSON line (run mode), or a tar of result.json plus
// artifacts (compile mode). Moved from main.go (was emit); mode now comes
// from r.Mode, which always equalled the options' mode.
func emitResult(w io.Writer, r Result) error {
	f := r
	if f.Mode != "compile" {
		return json.NewEncoder(w).Encode(f)
	}
	// compile: tar with result.json first, then artifacts.
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(f)
	tw := tar.NewWriter(w)
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
	return tw.Close()
}
