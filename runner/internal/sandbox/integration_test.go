//go:build integration

// Integration tests: require Docker and images built by scripts/build-images.ps1.
//
//	go test -tags integration -count=1 -v ./internal/sandbox/
package sandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

var sb *Sandbox

func TestMain(m *testing.M) {
	ctx := context.Background()
	seccomp, err := FindRepoFile("sandbox/seccomp/default.json")
	must(err)
	lock, err := FindRepoFile("sandbox/images/images.lock.json")
	must(err)
	sb, err = New(ctx, Options{SeccompPath: seccomp, ImagesLockPath: lock, Concurrency: 2})
	must(err)
	fmt.Printf("docker API negotiated: %s\n", sb.APIVersion())

	code := m.Run()

	// Invariant: nothing we created may outlive the suite.
	n, err := sb.ManagedContainers(ctx)
	if err != nil {
		fmt.Println("FAIL: list managed containers:", err)
		code = 1
	} else if n != 0 {
		fmt.Printf("FAIL: %d judge.managed containers left after suite\n", n)
		code = 1
	} else {
		fmt.Println("post-suite: 0 judge.managed containers left")
	}
	sb.Close()
	os.Exit(code)
}

func must(err error) {
	if err != nil {
		fmt.Println("setup:", err)
		os.Exit(1)
	}
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func langOf(t *testing.T, file string) lang.Lang {
	t.Helper()
	name := "cpp"
	if strings.HasSuffix(file, ".py") {
		name = "python"
	}
	l, err := lang.Get(name)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func execute(t *testing.T, file, stdin string, lim Limits) *Result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	res, err := sb.Execute(ctx, langOf(t, file), fixture(t, file), []byte(stdin), lim)
	if err != nil {
		t.Fatalf("Execute(%s): %v", file, err)
	}
	t.Logf("%s -> status=%s reason=%q exit=%d sig=%d cpu=%dms wall=%dms rss=%dKB oom=%v compile=%dms run=%dms stdout=%q stderr=%.200q",
		file, res.Status, res.Reason, res.ExitCode, res.Signal, res.CPUMs, res.WallMs, res.MaxRSSKB, res.OOMKilled,
		res.CompileMs, res.RunMs, trunc(res.Stdout, 120), res.Stderr)
	return res
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

var std = Limits{TimeLimit: 2 * time.Second, MemoryMB: 256}

func wantStatus(t *testing.T, res *Result, want string) {
	t.Helper()
	if res.Status != want {
		t.Fatalf("status = %s (reason %q), want %s", res.Status, res.Reason, want)
	}
}

func TestOK(t *testing.T) {
	for _, f := range []string{"ok.cpp", "ok.py"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "40 2\n", std)
			wantStatus(t, res, StatusOK)
			if strings.TrimSpace(res.Stdout) != "42" {
				t.Fatalf("stdout = %q, want 42", res.Stdout)
			}
		})
	}
}

func TestCE(t *testing.T) {
	for _, f := range []string{"ce.cpp", "ce.py"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", std)
			wantStatus(t, res, StatusCE)
			if res.CompileOutput == "" {
				t.Fatal("expected compiler diagnostics")
			}
		})
	}
}

func TestRE(t *testing.T) {
	t.Run("segfault", func(t *testing.T) {
		res := execute(t, "segv.cpp", "", std)
		wantStatus(t, res, StatusRE)
		if res.Signal != 11 {
			t.Fatalf("signal = %d, want 11 (SIGSEGV)", res.Signal)
		}
	})
	t.Run("nonzero-exit", func(t *testing.T) {
		res := execute(t, "exit3.cpp", "", std)
		wantStatus(t, res, StatusRE)
		if res.ExitCode != 3 {
			t.Fatalf("exit = %d, want 3", res.ExitCode)
		}
	})
	t.Run("python-exception", func(t *testing.T) {
		res := execute(t, "exc.py", "", std)
		wantStatus(t, res, StatusRE)
		if !strings.Contains(res.Stderr, "ValueError: boom") {
			t.Fatalf("stderr missing traceback: %q", res.Stderr)
		}
	})
}

func TestTLE(t *testing.T) {
	t.Run("busy-loop-cpu", func(t *testing.T) {
		res := execute(t, "busy.cpp", "", std)
		wantStatus(t, res, StatusTLE)
		if res.CPUMs < std.TimeLimit.Milliseconds() {
			t.Fatalf("cpu = %dms, expected > limit", res.CPUMs)
		}
	})
	t.Run("sleep-forever-wall", func(t *testing.T) {
		res := execute(t, "sleep.cpp", "", std)
		wantStatus(t, res, StatusTLE)
		if res.CPUMs > 200 {
			t.Fatalf("cpu = %dms; a sleeper should use ~0 CPU, so this must be the wall limit", res.CPUMs)
		}
		if res.WallMs < WallLimit(std.TimeLimit).Milliseconds() {
			t.Fatalf("wall = %dms, want >= %v", res.WallMs, WallLimit(std.TimeLimit))
		}
	})
}

func TestMLE(t *testing.T) {
	// 64 MB limit; generous CPU so MLE (not TLE) is the binding limit even on
	// this host's slow page-fault path (see docs/PHASE0.md V2).
	lim := Limits{TimeLimit: 5 * time.Second, MemoryMB: 64}
	for _, f := range []string{"mle.cpp", "mle.py"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", lim)
			wantStatus(t, res, StatusMLE)
		})
	}
}

func TestOLE(t *testing.T) {
	lim := Limits{TimeLimit: 2 * time.Second, MemoryMB: 256, OutputBytes: 1 << 20}
	res := execute(t, "ole.cpp", "", lim)
	wantStatus(t, res, StatusOLE)
	if int64(len(res.Stdout)) > lim.OutputBytes {
		t.Fatalf("returned stdout %d bytes > cap %d", len(res.Stdout), lim.OutputBytes)
	}
}

func TestSeccompActive(t *testing.T) {
	res := execute(t, "keyctl.cpp", "", std)
	wantStatus(t, res, StatusOK)
	if !strings.Contains(res.Stdout, "EPERM") {
		t.Fatalf("keyctl not blocked by seccomp: %q", res.Stdout)
	}
}

func TestNetworkBlocked(t *testing.T) {
	res := execute(t, "net.py", "", std)
	wantStatus(t, res, StatusOK)
	if strings.Contains(res.Stdout, "CONNECTED") || strings.Contains(res.Stdout, "DNS-RESOLVED") {
		t.Fatalf("network reachable: %q", res.Stdout)
	}
	if !strings.Contains(res.Stdout, "blocked:") {
		t.Fatalf("unexpected output: %q", res.Stdout)
	}
}

func TestProcessLimit(t *testing.T) {
	res := execute(t, "fork.cpp", "", std)
	wantStatus(t, res, StatusOK)
	var started, failed int
	if _, err := fmt.Sscanf(strings.TrimSpace(res.Stdout), "started=%d failed=%d", &started, &failed); err != nil {
		t.Fatalf("parse %q: %v", res.Stdout, err)
	}
	if started >= runPids || failed == 0 {
		t.Fatalf("pids limit not enforced: started=%d failed=%d (limit %d)", started, failed, runPids)
	}
}

// 8 distinct programs in parallel (through the semaphore); each must get
// exactly its own output back.
func TestConcurrencyIsolation(t *testing.T) {
	const n = 8
	l, _ := lang.Get("python")
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			src := fmt.Sprintf("import sys, time\ntok = sys.stdin.read().strip()\nfor k in range(300):\n    print('prog%d', tok, k)\n    if k %% 100 == 0:\n        time.sleep(0.05)\n", i)
			stdin := fmt.Sprintf("input-%d", i)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			res, err := sb.Execute(ctx, l, []byte(src), []byte(stdin), std)
			if err != nil {
				errs <- fmt.Errorf("prog%d: %v", i, err)
				return
			}
			var want strings.Builder
			for k := 0; k < 300; k++ {
				fmt.Fprintf(&want, "prog%d input-%d %d\n", i, i, k)
			}
			if res.Status != StatusOK || res.Stdout != want.String() {
				errs <- fmt.Errorf("prog%d: status=%s reason=%q stdout mismatch (got %d bytes, first line %q)", i, res.Status, res.Reason, len(res.Stdout), strings.SplitN(res.Stdout, "\n", 2)[0])
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

// A program (and a delayed forked child) trying to forge an OK result frame
// must not change the verdict: the real program exits 3 => RE.
func TestVerdictForgery(t *testing.T) {
	for _, f := range []string{"forge.cpp", "forge.py"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", std)
			wantStatus(t, res, StatusRE)
			if res.ExitCode != 3 {
				t.Fatalf("exit = %d, want 3", res.ExitCode)
			}
			if !strings.Contains(res.Stderr, "open /proc/1/fd/1: Permission denied") {
				t.Fatalf("expected /proc/1/fd/1 to be denied, stderr=%q", res.Stderr)
			}
			if strings.Contains(res.Stderr, "INJECTED") || strings.Contains(res.Stderr, "child:") {
				t.Fatalf("forger made progress: %q", res.Stderr)
			}
		})
	}
}

// The reaper removes containers of dead instances and leaves those of live
// instances alone. Uses never-started containers with crafted labels.
func TestReaperInstances(t *testing.T) {
	ctx := context.Background()
	mk := func(labels map[string]string) string {
		labels[LabelManaged] = "true"
		labels["judge.role"] = "reaper-test"
		cr, err := sb.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
			Name:       randName(),
			Config:     &container.Config{Image: sb.images["cpp-run"], Cmd: []string{"run", "--", "/none"}, Labels: labels, NetworkDisabled: true},
			HostConfig: &container.HostConfig{NetworkMode: "none", ReadonlyRootfs: true, CapDrop: []string{"ALL"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = sb.cli.ContainerRemove(context.Background(), cr.ID, client.ContainerRemoveOptions{Force: true})
		})
		return cr.ID
	}
	exists := func(id string) bool {
		_, err := sb.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
		return err == nil
	}

	dead := self.labels()
	dead[LabelInstance] = "deadinstance0001"
	dead[LabelPID] = "999999" // no such process
	live := self.labels()
	live[LabelInstance] = "liveinstance0001" // another runner in this (live) process identity
	legacy := map[string]string{}            // Phase 1 container: no instance labels

	deadID, liveID, legacyID := mk(dead), mk(live), mk(legacy)
	n, err := sb.Reap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("reaped %d", n)
	if exists(deadID) {
		t.Error("container of dead instance was not reaped")
	}
	if exists(legacyID) {
		t.Error("unlabelled legacy container was not reaped")
	}
	if !exists(liveID) {
		t.Error("container of a live instance was reaped")
	}
}
