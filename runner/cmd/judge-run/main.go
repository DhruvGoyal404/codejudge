// Command judge-run runs programs in the sandbox and prints JSON.
//
//	judge-run [run] --lang cpp|python --src FILE [--stdin FILE] --time-limit 2s --memory-limit 256
//	judge-run judge --problem problems/<slug> --lang cpp|python --src FILE [--run-all] [--mode batch|per-test]
//	judge-run outputs --lang L --src FILE --inputs DIR --out DIR [--time-limit 10s --memory-limit 1024]
//
// outputs is a problem-authoring tool: it runs a reference solution on every
// DIR/NN.in in one batch container and writes its exact stdout to OUT/NN.out
// (failing on any non-OK or truncated run). scripts/make-tests.py uses it to
// cross-check the C++ and Python references byte for byte.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/judge"
	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "judge" {
		if err := judgeCmd(args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, "judge-run judge:", err)
			os.Exit(1)
		}
		return
	}
	if len(args) > 0 && args[0] == "outputs" {
		if err := outputsCmd(args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, "judge-run outputs:", err)
			os.Exit(1)
		}
		return
	}
	if len(args) > 0 && args[0] == "run" {
		os.Args = append(os.Args[:1], args[1:]...)
	}
	var (
		langName    = flag.String("lang", "", "language: cpp | python")
		srcPath     = flag.String("src", "", "source file")
		stdinPath   = flag.String("stdin", "", "stdin file (optional)")
		timeLimit   = flag.Duration("time-limit", 2*time.Second, "CPU time limit")
		memoryMB    = flag.Int64("memory-limit", 256, "memory limit in MB")
		outputBytes = flag.Int64("output-limit", sandbox.DefaultOutputBytes, "stdout limit in bytes")
		seccomp     = flag.String("seccomp", "", "seccomp profile (default: find sandbox/seccomp/default.json)")
		imagesLock  = flag.String("images", "", "image lock (default: find sandbox/images/images.lock.json)")
		runtime     = flag.String("runtime", os.Getenv("JUDGE_RUNTIME"), "OCI runtime, e.g. runsc (default: $JUDGE_RUNTIME, else the engine default)")
	)
	flag.Parse()
	if err := run(*langName, *srcPath, *stdinPath, *seccomp, *imagesLock, *runtime, sandbox.Limits{TimeLimit: *timeLimit, MemoryMB: *memoryMB, OutputBytes: *outputBytes}); err != nil {
		fmt.Fprintln(os.Stderr, "judge-run:", err)
		os.Exit(1)
	}
}

func run(langName, srcPath, stdinPath, seccompPath, lockPath, runtimeName string, lim sandbox.Limits) error {
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
	sb, err := sandbox.New(ctx, sandbox.Options{SeccompPath: seccompPath, ImagesLockPath: lockPath, Runtime: runtimeName})
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

func judgeCmd(args []string) error {
	fs := flag.NewFlagSet("judge", flag.ContinueOnError)
	probDir := fs.String("problem", "", "problem package directory (problems/<slug>)")
	langName := fs.String("lang", "", "language: cpp | python")
	srcPath := fs.String("src", "", "source file")
	runAll := fs.Bool("run-all", false, "run every test instead of stopping at the first non-AC")
	mode := fs.String("mode", judge.ModeBatch, "batch | per-test")
	seccompPath := fs.String("seccomp", "", "seccomp profile (default: find sandbox/seccomp/default.json)")
	lockPath := fs.String("images", "", "image lock (default: find sandbox/images/images.lock.json)")
	runtime := fs.String("runtime", os.Getenv("JUDGE_RUNTIME"), "OCI runtime, e.g. runsc (default: $JUDGE_RUNTIME, else the engine default)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *probDir == "" || *srcPath == "" {
		return fmt.Errorf("--problem and --src are required")
	}
	l, err := lang.Get(*langName)
	if err != nil {
		return err
	}
	p, err := problem.Load(*probDir)
	if err != nil {
		return err
	}
	src, err := os.ReadFile(*srcPath)
	if err != nil {
		return err
	}
	if *seccompPath == "" {
		if *seccompPath, err = sandbox.FindRepoFile("sandbox/seccomp/default.json"); err != nil {
			return err
		}
	}
	if *lockPath == "" {
		if *lockPath, err = sandbox.FindRepoFile("sandbox/images/images.lock.json"); err != nil {
			return err
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	sb, err := sandbox.New(ctx, sandbox.Options{SeccompPath: *seccompPath, ImagesLockPath: *lockPath, Runtime: *runtime})
	if err != nil {
		return err
	}
	defer sb.Close()
	res, err := judge.Judge(ctx, sb, p, l, src, judge.Options{RunAll: *runAll, Mode: *mode})
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(res)
}

func outputsCmd(args []string) error {
	fs := flag.NewFlagSet("outputs", flag.ContinueOnError)
	langName := fs.String("lang", "", "language: c | cpp | go | python | java | javascript")
	srcPath := fs.String("src", "", "source file")
	inDir := fs.String("inputs", "", "directory of NN.in files")
	outDir := fs.String("out", "", "directory to write NN.out files to")
	timeLimit := fs.Duration("time-limit", 10*time.Second, "CPU time limit per input")
	memoryMB := fs.Int64("memory-limit", 1024, "memory limit in MB")
	outputBytes := fs.Int64("output-limit", sandbox.MaxOutputBytes, "stdout limit per input in bytes (larger than any valid expected output, so an over-long reference output is caught by judge-admin check)")
	seccompPath := fs.String("seccomp", "", "seccomp profile (default: find sandbox/seccomp/default.json)")
	lockPath := fs.String("images", "", "image lock (default: find sandbox/images/images.lock.json)")
	runtime := fs.String("runtime", os.Getenv("JUDGE_RUNTIME"), "OCI runtime, e.g. runsc (default: $JUDGE_RUNTIME, else the engine default)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *srcPath == "" || *inDir == "" || *outDir == "" {
		return fmt.Errorf("--src, --inputs and --out are required")
	}
	l, err := lang.Get(*langName)
	if err != nil {
		return err
	}
	src, err := os.ReadFile(*srcPath)
	if err != nil {
		return err
	}
	ins, err := filepath.Glob(filepath.Join(*inDir, "*.in"))
	if err != nil {
		return err
	}
	if len(ins) == 0 {
		return fmt.Errorf("no .in files in %s", *inDir)
	}
	sort.Strings(ins)
	inputs := make([][]byte, len(ins))
	maxIn, total := 0, 0
	for i, path := range ins {
		if inputs[i], err = os.ReadFile(path); err != nil {
			return err
		}
		maxIn = max(maxIn, len(inputs[i]))
		total += len(inputs[i])
	}
	if *seccompPath == "" {
		if *seccompPath, err = sandbox.FindRepoFile("sandbox/seccomp/default.json"); err != nil {
			return err
		}
	}
	if *lockPath == "" {
		if *lockPath, err = sandbox.FindRepoFile("sandbox/images/images.lock.json"); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	sb, err := sandbox.New(ctx, sandbox.Options{SeccompPath: *seccompPath, ImagesLockPath: *lockPath, Runtime: *runtime})
	if err != nil {
		return err
	}
	defer sb.Close()
	c, cres, err := sb.Compile(ctx, l, src)
	if err != nil {
		return err
	}
	if c == nil {
		return fmt.Errorf("compile: %s %s\n%s", cres.Status, cres.Reason, cres.Stderr)
	}
	lim := sandbox.Limits{TimeLimit: *timeLimit, MemoryMB: *memoryMB, OutputBytes: *outputBytes}
	b, err := sb.StartBatch(ctx, c, lim, len(inputs), maxIn, total)
	if err != nil {
		return err
	}
	defer b.Close()
	var maxCPU int64
	for i, in := range inputs {
		name := strings.TrimSuffix(filepath.Base(ins[i]), ".in")
		res, err := b.Run(in)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if res.Status != sandbox.StatusOK || res.StdoutTruncated {
			return fmt.Errorf("%s: %s %s (truncated=%v)\n%.2000s", name, res.Status, res.Reason, res.StdoutTruncated, res.Stderr)
		}
		if err := os.WriteFile(filepath.Join(*outDir, name+".out"), []byte(res.Stdout), 0o644); err != nil {
			return err
		}
		maxCPU = max(maxCPU, res.CPUMs)
	}
	fmt.Printf("%d outputs, max cpu %dms\n", len(inputs), maxCPU)
	return nil
}
