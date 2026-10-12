// Command judge-run compiles and runs one program in the sandbox and prints
// the result as JSON.
//
//	judge-run --lang cpp|python --src FILE [--stdin FILE] --time-limit 2s --memory-limit 256
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

func main() {
	var (
		langName    = flag.String("lang", "", "language: cpp | python")
		srcPath     = flag.String("src", "", "source file")
		stdinPath   = flag.String("stdin", "", "stdin file (optional)")
		timeLimit   = flag.Duration("time-limit", 2*time.Second, "CPU time limit")
		memoryMB    = flag.Int64("memory-limit", 256, "memory limit in MB")
		outputBytes = flag.Int64("output-limit", sandbox.DefaultOutputBytes, "stdout limit in bytes")
		seccomp     = flag.String("seccomp", "", "seccomp profile (default: find sandbox/seccomp/default.json)")
		imagesLock  = flag.String("images", "", "image lock (default: find sandbox/images/images.lock.json)")
	)
	flag.Parse()
	if err := run(*langName, *srcPath, *stdinPath, *seccomp, *imagesLock, sandbox.Limits{TimeLimit: *timeLimit, MemoryMB: *memoryMB, OutputBytes: *outputBytes}); err != nil {
		fmt.Fprintln(os.Stderr, "judge-run:", err)
		os.Exit(1)
	}
}

func run(langName, srcPath, stdinPath, seccompPath, lockPath string, lim sandbox.Limits) error {
	l, err := lang.Get(langName)
	if err != nil {
		return err
	}
	if srcPath == "" {
		return fmt.Errorf("--src is required")
	}
	if lim.TimeLimit <= 0 || lim.MemoryMB <= 0 {
		return fmt.Errorf("--time-limit and --memory-limit must be positive")
	}
	src, err := os.ReadFile(srcPath)
	if err != nil {
		return err
	}
	var stdin []byte
	if stdinPath != "" {
		if stdin, err = os.ReadFile(stdinPath); err != nil {
			return err
		}
	}
	if seccompPath == "" {
		if seccompPath, err = sandbox.FindRepoFile("sandbox/seccomp/default.json"); err != nil {
			return err
		}
	}
	if lockPath == "" {
		if lockPath, err = sandbox.FindRepoFile("sandbox/images/images.lock.json"); err != nil {
			return err
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	sb, err := sandbox.New(ctx, sandbox.Options{SeccompPath: seccompPath, ImagesLockPath: lockPath})
	if err != nil {
		return err
	}
	defer sb.Close()

	res, err := sb.Execute(ctx, l, src, stdin, lim)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(res)
}
