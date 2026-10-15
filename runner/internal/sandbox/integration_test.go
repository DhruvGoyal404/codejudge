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
	"strconv"
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
	// JUDGE_TEST_RUNTIME=runsc runs the whole suite under gVisor (CI does both).
	sb, err = New(ctx, Options{SeccompPath: seccomp, ImagesLockPath: lock, Concurrency: 2, Runtime: os.Getenv("JUDGE_TEST_RUNTIME")})
	must(err)
	fmt.Printf("docker API negotiated: %s; runtime: %q\n", sb.APIVersion(), os.Getenv("JUDGE_TEST_RUNTIME"))

	code := m.Run()

	// Invariant: nothing we created may outlive the suite.
	n, err := sb.OwnContainers(ctx) // only this process: other suites may run concurrently
	if err != nil {
		fmt.Println("FAIL: list managed containers:", err)
		code = 1
	} else if n != 0 {
		fmt.Printf("FAIL: %d judge.managed containers left by this process after suite\n", n)
		code = 1
	} else {
		fmt.Println("post-suite: 0 judge.managed containers left by this process")
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
	switch {
	case strings.HasSuffix(file, ".py"):
		name = "python"
	case strings.HasSuffix(file, ".java"):
		name = "java"
	case strings.HasSuffix(file, ".js"):
		name = "javascript"
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
	for _, f := range []string{"ok.cpp", "ok.py", "ok.java", "ok.js"} {
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
	for _, f := range []string{"ce.cpp", "ce.py", "ce.java", "ce.js", "nomain.java"} {
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
	for f, want := range map[string]string{
		"exc.py":   "ValueError: boom",
		"exc.java": "java.lang.IllegalStateException: boom",
		"exc.js":   "Error: boom",
	} {
		t.Run("exception/"+f, func(t *testing.T) {
			res := execute(t, f, "", std)
			wantStatus(t, res, StatusRE)
			if !strings.Contains(res.Stderr, want) {
				t.Fatalf("stderr missing %q: %q", want, res.Stderr)
			}
		})
	}
}

func TestTLE(t *testing.T) {
	for _, ext := range []string{"cpp", "java", "js"} {
		t.Run("busy-loop-cpu/"+ext, func(t *testing.T) {
			res := execute(t, "busy."+ext, "", std)
			wantStatus(t, res, StatusTLE)
			if res.CPUMs < std.TimeLimit.Milliseconds() {
				t.Fatalf("cpu = %dms, expected > limit", res.CPUMs)
			}
		})
		t.Run("sleep-forever-wall/"+ext, func(t *testing.T) {
			res := execute(t, "sleep."+ext, "", std)
			wantStatus(t, res, StatusTLE)
			// A sleeper uses ~0 CPU (runtimes: start-up only), so this is the wall limit.
			if res.CPUMs > 600 {
				t.Fatalf("cpu = %dms; expected a wall-limit kill", res.CPUMs)
			}
			if res.WallMs < WallLimit(std.TimeLimit).Milliseconds() {
				t.Fatalf("wall = %dms, want >= %v", res.WallMs, WallLimit(std.TimeLimit))
			}
		})
	}
}

func TestMLE(t *testing.T) {
	// 64 MB limit; generous CPU so MLE (not TLE) is the binding limit even on
	// this host's slow page-fault path (see docs/PHASE0.md V2).
	lim := Limits{TimeLimit: 5 * time.Second, MemoryMB: 64}
	for _, f := range []string{"mle.cpp", "mle.py", "mle.java", "mle.js"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", lim)
			wantStatus(t, res, StatusMLE)
		})
	}
}

func TestOLE(t *testing.T) {
	lim := Limits{TimeLimit: 2 * time.Second, MemoryMB: 256, OutputBytes: 1 << 20}
	// The JVM ignores SIGXFSZ and Node buffers failed writes: judge-exec stops
	// the program when stdout reaches the cap, so all report OLE.
	for _, f := range []string{"ole.cpp", "ole.java", "ole.js"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", lim)
			wantStatus(t, res, StatusOLE)
			if int64(len(res.Stdout)) > lim.OutputBytes {
				t.Fatalf("returned stdout %d bytes > cap %d", len(res.Stdout), lim.OutputBytes)
			}
		})
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

// A program that doesn't handle hitting the process/thread limit dies (RE),
// and judge-exec survives to report it: never IE (under runsc, RLIMIT_NPROC
// keeps guest tasks inside the container's pids budget).
func TestProcessLimitUnhandled(t *testing.T) {
	res := execute(t, "threadbomb.cpp", "", std)
	wantStatus(t, res, StatusRE)
	if strings.Contains(res.Stdout, "unreachable") {
		t.Fatalf("no process limit: %q", res.Stdout)
	}
}

func TestProcessLimit(t *testing.T) {
	res := execute(t, "fork.cpp", "", std)
	wantStatus(t, res, StatusOK)
	var started, failed int
	if _, err := fmt.Sscanf(strings.TrimSpace(res.Stdout), "started=%d failed=%d", &started, &failed); err != nil {
		t.Fatalf("parse %q: %v", res.Stdout, err)
	}
	limit := runcNproc // RLIMIT_NPROC is the binding limit (judge-exec's threads count too)
	if IsGVisor(os.Getenv("JUDGE_TEST_RUNTIME")) {
		limit = runscNproc
	}
	if started >= limit || failed == 0 {
		t.Fatalf("process limit not enforced: started=%d failed=%d (limit %d)", started, failed, limit)
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

// Multithreaded programs work under both runtimes (glibc pthread_create uses
// clone3; under runc it falls back to clone on ENOSYS, under runsc clone3 is
// allowed by the gVisor profile variant).
func TestThreads(t *testing.T) {
	for _, f := range []string{"threads.cpp", "threads.py", "threads.java"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", std)
			wantStatus(t, res, StatusOK)
			if strings.TrimSpace(res.Stdout) != "threads=8 sum=499999500000" {
				t.Fatalf("stdout %q", res.Stdout)
			}
		})
	}
}

// clone3 per runtime: ENOSYS under runc (the base profile), allowed under
// runsc (gVisor variant), and namespace creation fails under both.
func TestClone3(t *testing.T) {
	res := execute(t, "clone3.cpp", "", std)
	wantStatus(t, res, StatusOK)
	got := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(res.Stdout), "\n") {
		if k, v, ok := strings.Cut(line, ": "); ok {
			got[k] = v
		}
	}
	runtime := os.Getenv("JUDGE_TEST_RUNTIME")
	t.Logf("runtime %q: %v", runtime, got)
	if IsGVisor(runtime) {
		if got["plain"] != "ok" {
			t.Errorf("plain clone3 under runsc: %q, want ok", got["plain"])
		}
	} else if !strings.HasPrefix(got["plain"], "errno=38") {
		t.Errorf("plain clone3 under runc: %q, want ENOSYS (errno=38)", got["plain"])
	}
	// CLONE_NEWPID needs CAP_SYS_ADMIN: it must fail under both runtimes.
	if !strings.HasPrefix(got["newpid"], "errno=") {
		t.Errorf("clone3 with newpid: %q, want failure", got["newpid"])
	}
	if !IsGVisor(runtime) {
		// runc: every clone3 is ENOSYS (glibc falls back to the filtered clone).
		for _, ns := range []string{"newuser", "newns"} {
			if !strings.HasPrefix(got[ns], "errno=") {
				t.Errorf("clone3 with %s under runc: %q, want failure", ns, got[ns])
			}
		}
		return
	}
	// runsc: user/mount namespace results are recorded, not asserted (they
	// would exist only inside the Sentry; accepted risk, docs/PHASE6.md 6a.7),
	// so a change in gVisor's behaviour shows up in the log.
	t.Logf("ACCEPTED RISK under runsc: clone3 newuser=%q newns=%q", got["newuser"], got["newns"])
}

// A multithreaded program that crashes is RE at once, not a slow core dump
// that runs into the wall limit.
func TestCrashWithThreads(t *testing.T) {
	res := execute(t, "segv_threads.cpp", "", std)
	wantStatus(t, res, StatusRE)
	if res.WallMs > 1000 {
		t.Fatalf("crash took %d ms (core dump not suppressed?)", res.WallMs)
	}
}

// Containers never share a uid, even when two independent sandboxes (as two
// worker processes would) allocate at once. Checked on the host: while the
// programs run, every snapshot of the daemon's judge.managed containers (any
// state) must carry each judge.uid label at most once. In-container clocks
// are not compared: separate gVisor sandboxes need not agree on wall time.
func TestUIDsUniqueAcrossLiveContainers(t *testing.T) {
	seccomp, err := FindRepoFile("sandbox/seccomp/default.json")
	if err != nil {
		t.Fatal(err)
	}
	lock, err := FindRepoFile("sandbox/images/images.lock.json")
	if err != nil {
		t.Fatal(err)
	}
	const perSandbox = 6
	var sbs []*Sandbox
	for i := 0; i < 2; i++ {
		s, err := New(context.Background(), Options{SeccompPath: seccomp, ImagesLockPath: lock, Concurrency: perSandbox, Runtime: os.Getenv("JUDGE_TEST_RUNTIME")})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		sbs = append(sbs, s)
	}

	// Watcher: snapshots until the runs finish.
	stop := make(chan struct{})
	watchDone := make(chan struct{})
	var dup string
	maxRunning, snapshots := 0, 0
	go func() {
		defer close(watchDone)
		for {
			select {
			case <-stop:
				return
			default:
			}
			list, err := sbs[0].cli.ContainerList(context.Background(), client.ContainerListOptions{
				All: true, Filters: make(client.Filters).Add("label", LabelManaged+"=true"),
			})
			if err == nil {
				snapshots++
				seen, running := map[string]string{}, 0
				for _, c := range list.Items {
					u := c.Labels[labelUID]
					if u == "" {
						continue
					}
					if other, ok := seen[u]; ok && dup == "" {
						dup = fmt.Sprintf("uid %s held by %s and %s at once", u, other[:12], c.ID[:12])
					}
					seen[u] = c.ID
					if c.State == "running" {
						running++
					}
				}
				maxRunning = max(maxRunning, running)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()

	l := langOf(t, "uid.py")
	src := fixture(t, "uid.py")
	var mu sync.Mutex
	var uids []uint64
	var wg sync.WaitGroup
	for _, s := range sbs {
		for i := 0; i < perSandbox; i++ {
			wg.Add(1)
			go func(s *Sandbox) {
				defer wg.Done()
				res, err := s.Execute(context.Background(), l, src, nil, std)
				if err != nil || res.Status != StatusOK {
					t.Errorf("run: %v %+v", err, res)
					return
				}
				var uid, gid uint64
				var start, end int64
				if _, err := fmt.Sscanf(strings.TrimSpace(res.Stdout), "%d %d %d %d", &uid, &gid, &start, &end); err != nil {
					t.Errorf("parse %q: %v", res.Stdout, err)
					return
				}
				if uid != gid || uid < SandboxUIDBase || uid >= SandboxUIDBase+SandboxUIDCount {
					t.Errorf("bad uid/gid %d/%d", uid, gid)
				}
				mu.Lock()
				uids = append(uids, uid)
				mu.Unlock()
			}(s)
		}
	}
	wg.Wait()
	close(stop)
	<-watchDone
	t.Logf("%d runs, %d snapshots, at most %d containers running at once", len(uids), snapshots, maxRunning)
	if dup != "" {
		t.Fatal(dup)
	}
	// More running at once than one sandbox's concurrency: both allocated concurrently.
	if len(uids) != 2*perSandbox || maxRunning <= perSandbox {
		t.Fatalf("test did not exercise concurrent allocation: %d runs, max %d running", len(uids), maxRunning)
	}
}

// A uid whose name is taken by another container is never used: creation
// moves on to a free uid (the name reservation is what makes uids unique).
func TestUIDNameConflictRetries(t *testing.T) {
	ctx := context.Background()
	live, err := sb.liveUIDs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Squat the uid this sandbox would hand out next, without its label, so
	// only the name reservation can stop it from being reused.
	sb.uids.mu.Lock()
	next := sb.uids.base + sb.uids.next
	sb.uids.mu.Unlock()
	for live[next] {
		next++
	}
	img, ok := sb.images["python"]
	if !ok {
		t.Fatal("python image not in lock")
	}
	squat, err := sb.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:   uidName(next),
		Config: &container.Config{Image: img, Labels: map[string]string{LabelManaged: "true"}, Cmd: []string{"true"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sb.removeContainer(squat.ID)
	res := execute(t, "uid.py", "", std)
	wantStatus(t, res, StatusOK)
	var uid uint64
	fmt.Sscanf(res.Stdout, "%d", &uid)
	if uint32(uid) == next {
		t.Fatalf("got uid %d although its name is held by another container", uid)
	}
}

// Deep recursion works: -Xss (Java) and --stack-size (Node) are derived from
// the memory limit, below RLIMIT_STACK.
func TestDeepRecursion(t *testing.T) {
	for _, f := range []string{"recursion.java", "recursion.js"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", std)
			wantStatus(t, res, StatusOK)
			if strings.TrimSpace(res.Stdout) != "200000" {
				t.Fatalf("stdout %q", res.Stdout)
			}
		})
	}
}

// The runtimes' own threads fit their process budget with room to spare
// (calibrates lang.ExtraTasks; logged per runtime).
func TestRuntimeThreadsFit(t *testing.T) {
	for _, f := range []string{"threadcount.java", "threadcount.js"} {
		t.Run(f, func(t *testing.T) {
			res := execute(t, f, "", std)
			wantStatus(t, res, StatusOK)
			n, err := strconv.Atoi(strings.TrimSpace(res.Stdout))
			if err != nil {
				t.Fatalf("stdout %q", res.Stdout)
			}
			l := langOf(t, f)
			budget := runcNproc + l.ExtraTasks
			if IsGVisor(os.Getenv("JUDGE_TEST_RUNTIME")) {
				budget = runscNproc + l.ExtraTasks
			}
			t.Logf("%s: %d threads at start-up, process budget %d", f, n, budget)
			if n > budget/2 {
				t.Fatalf("%d start-up threads leave too little of the %d budget", n, budget)
			}
		})
	}
}
