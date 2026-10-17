//go:build integration

package sandbox

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"
)

func compileFixture(t *testing.T, file string) *Compiled {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	c, cres, err := sb.Compile(ctx, langOf(t, file), fixture(t, file))
	if err != nil || c == nil {
		t.Fatalf("compile %s: %v %+v", file, err, cres)
	}
	return c
}

func startBatch(t *testing.T, c *Compiled, inputs []string, lim Limits) *Batch {
	t.Helper()
	maxIn, total := 0, 0
	for _, in := range inputs {
		maxIn = max(maxIn, len(in))
		total += len(in)
	}
	b, err := sb.StartBatch(context.Background(), c, lim, len(inputs), maxIn, total)
	if err != nil {
		t.Fatalf("StartBatch: %v", err)
	}
	t.Cleanup(b.Close)
	return b
}

// runBatchFixture runs every input through one batch container.
func runBatchFixture(t *testing.T, file string, inputs []string, lim Limits) []*Result {
	t.Helper()
	b := startBatch(t, compileFixture(t, file), inputs, lim)
	var out []*Result
	for i, in := range inputs {
		res, err := b.Run([]byte(in))
		if err != nil {
			t.Fatalf("test %d: %v", i+1, err)
		}
		t.Logf("%s test %d -> status=%s reason=%q exit=%d sig=%d cpu=%dms rss=%dKB run=%dms stdout=%q stderr=%.200q",
			file, i+1, res.Status, res.Reason, res.ExitCode, res.Signal, res.CPUMs, res.MaxRSSKB, res.RunMs, trunc(res.Stdout, 300), res.Stderr)
		out = append(out, res)
	}
	b.Close()
	return out
}

func TestBatchOK(t *testing.T) {
	for _, f := range []string{"ok.cpp", "ok.py", "ok.java", "ok.js", "ok.c", "ok.go"} {
		t.Run(f, func(t *testing.T) {
			res := runBatchFixture(t, f, []string{"1 2\n", "40 2\n", "-5 5\n"}, std)
			for i, want := range []string{"3", "42", "0"} {
				wantStatus(t, res[i], StatusOK)
				if strings.TrimSpace(res[i].Stdout) != want {
					t.Fatalf("test %d stdout %q, want %s", i+1, res[i].Stdout, want)
				}
			}
		})
	}
}

// The program must not inherit any judge-exec descriptor: only its own input,
// its stdout/stderr files and the directory it is listing may appear.
func TestBatchFDs(t *testing.T) {
	allowed := map[string]bool{"/box/input": true, "/box/.stdout": true, "/box/.stderr": true}
	// The JVM and Node open their own files, epoll/eventfd handles and pipes;
	// sockets and anything else are still rejected. (That judge-exec passes
	// only 0-2 to the program is proven exactly by the C++/Python/C variants.)
	// The Go runtime may hold an epoll/eventfd pair once its poller starts.
	runtimeOwn := func(f, target string) bool {
		switch {
		case strings.HasSuffix(f, ".java"):
			return strings.HasPrefix(target, "/opt/java/") || target == "/box/main.jar" ||
				strings.HasPrefix(target, "anon_inode:") || strings.HasPrefix(target, "pipe:") || strings.HasPrefix(target, "/dev/")
		case strings.HasSuffix(f, ".js"):
			return strings.HasPrefix(target, "anon_inode:") || strings.HasPrefix(target, "pipe:") ||
				strings.HasPrefix(target, "/usr/") || strings.HasPrefix(target, "/dev/") || target == "/box/main.js"
		case strings.HasSuffix(f, ".go"):
			// The runtime keeps its own cgroup's CPU limit files open
			// (cgroup-aware GOMAXPROCS, Go 1.25+; read-only, the container's
			// own limit): cpu.max on cgroup v2 (runc here), the v1 cfs files
			// under gVisor, which presents cgroup v1.
			return target == "/sys/fs/cgroup/cpu.max" ||
				target == "/sys/fs/cgroup/cpu/cpu.cfs_quota_us" || target == "/sys/fs/cgroup/cpu/cpu.cfs_period_us" ||
				strings.HasPrefix(target, "anon_inode:[eventpoll]") || strings.HasPrefix(target, "anon_inode:[eventfd]")
		}
		return false
	}
	for _, f := range []string{"fds.cpp", "fds.py", "fds.java", "fds.js", "fds.c", "fds.go"} {
		t.Run(f, func(t *testing.T) {
			for i, res := range runBatchFixture(t, f, []string{"first", "second"}, std) {
				wantStatus(t, res, StatusOK)
				seen := map[string]bool{}
				for _, line := range strings.Split(strings.TrimSpace(res.Stdout), "\n") {
					_, target, ok := strings.Cut(line, " -> ")
					if !ok {
						t.Fatalf("test %d: unparseable line %q", i+1, line)
					}
					if !allowed[target] && !strings.HasPrefix(target, "/proc/") && !runtimeOwn(f, target) {
						t.Fatalf("test %d: program holds unexpected descriptor %q", i+1, line)
					}
					seen[target] = true
				}
				for a := range allowed {
					if !seen[a] {
						t.Fatalf("test %d: expected %s among descriptors, got %q", i+1, a, res.Stdout)
					}
				}
			}
		})
	}
}

// Reading past the end of its own input must never yield a later test's bytes.
func TestBatchStdinOverread(t *testing.T) {
	inputs := []string{"MARK-1", "MARK-2", "MARK-3"}
	for _, f := range []string{"overread.cpp", "overread.py", "overread.java", "overread.js", "overread.c", "overread.go"} {
		t.Run(f, func(t *testing.T) {
			for i, res := range runBatchFixture(t, f, inputs, std) {
				wantStatus(t, res, StatusOK)
				want := fmt.Sprintf("own=MARK-%d extra=0 extradata=", i+1)
				if strings.TrimSpace(res.Stdout) != want {
					t.Fatalf("test %d: got %q, want %q", i+1, res.Stdout, want)
				}
			}
		})
	}
}

// Other tests' inputs are never visible: later ones are not in the container
// yet, earlier ones (and anything the program left behind) have been wiped.
func TestBatchHiddenInputs(t *testing.T) {
	inputs := []string{"SECRET-1", "SECRET-2", "SECRET-3"}
	for _, f := range []string{"snoop.py", "snoop.java", "snoop.js", "snoop.c", "snoop.go"} {
		t.Run(f, func(t *testing.T) {
			for i, res := range runBatchFixture(t, f, inputs, std) {
				wantStatus(t, res, StatusOK)
				if !strings.Contains(res.Stdout, "own: SECRET-"+fmt.Sprint(i+1)) {
					t.Fatalf("test %d: own input missing: %q", i+1, res.Stdout)
				}
				for j := range inputs {
					if j != i && strings.Contains(res.Stdout, inputs[j]) {
						t.Fatalf("test %d saw %s: %q", i+1, inputs[j], res.Stdout)
					}
				}
				if strings.Contains(res.Stdout, "LEFTOVER") {
					t.Fatalf("test %d found files left by an earlier test: %q", i+1, res.Stdout)
				}
			}
		})
	}
}

// A1 result-integrity tests, in batch mode: verdicts reflect the real
// program, and the batch stays valid (nonce/seq) for the following test.
func TestBatchVerdictForgery(t *testing.T) {
	for _, f := range []string{"forge.cpp", "forge.py", "forge.java", "forge.js", "forge.c", "forge.go"} {
		t.Run(f, func(t *testing.T) {
			for i, res := range runBatchFixture(t, f, []string{"", ""}, std) {
				wantStatus(t, res, StatusRE)
				if res.ExitCode != 3 {
					t.Fatalf("test %d exit %d, want 3", i+1, res.ExitCode)
				}
				if !strings.Contains(res.Stderr, "open /proc/1/fd/1: Permission denied") || strings.Contains(res.Stderr, "INJECTED") {
					t.Fatalf("test %d: forgery made progress: %q", i+1, res.Stderr)
				}
				// The forked child must not get to act before it is reaped. The JVM
				// takes ~0.4 s to exit, so its child may run, but only its own
				// output is affected (the verdict above is still RE 3) and its
				// attempt on judge-exec's channel must have been denied too.
				if strings.Contains(res.Stderr, "child:") &&
					(!strings.HasSuffix(f, ".java") || !strings.Contains(res.Stderr, "child: open /proc/1/fd/1: Permission denied")) {
					t.Fatalf("test %d: forked child acted: %q", i+1, res.Stderr)
				}
			}
		})
	}
}

func TestBatchLimits(t *testing.T) {
	t.Run("wall-limit-each-test", func(t *testing.T) {
		for _, res := range runBatchFixture(t, "sleep.cpp", []string{"", ""}, std) {
			wantStatus(t, res, StatusTLE)
		}
	})
	t.Run("mle", func(t *testing.T) {
		res := runBatchFixture(t, "mle.cpp", []string{""}, Limits{TimeLimit: 5 * time.Second, MemoryMB: 64})
		wantStatus(t, res[0], StatusMLE)
	})
	// Go in batch mode: the run environment (GOMAXPROCS, GOMEMLIMIT) reaches
	// every test, and the runtime's out-of-memory is MLE.
	t.Run("go-env", func(t *testing.T) {
		for i, res := range runBatchFixture(t, "threadcount.go", []string{"", ""}, Limits{TimeLimit: 2 * time.Second, MemoryMB: 128}) {
			wantStatus(t, res, StatusOK)
			if !strings.Contains(res.Stderr, "GOMAXPROCS=1 memlimit=134217728") {
				t.Fatalf("test %d: run environment not applied: %q", i+1, res.Stderr)
			}
		}
	})
	t.Run("go-mle", func(t *testing.T) {
		res := runBatchFixture(t, "mle.go", []string{""}, Limits{TimeLimit: 5 * time.Second, MemoryMB: 64})
		wantStatus(t, res[0], StatusMLE)
	})
}

// If the container dies mid-batch, the current test gets IE (or MLE if it was
// OOM-killed), the batch is dead and is never reused.
func TestBatchContainerDeath(t *testing.T) {
	b := startBatch(t, compileFixture(t, "ok.py"), []string{"1 2\n", "3 4\n", "5 6\n"}, std)
	res, err := b.Run([]byte("1 2\n"))
	if err != nil {
		t.Fatal(err)
	}
	wantStatus(t, res, StatusOK)

	if _, err := sb.cli.ContainerKill(context.Background(), b.id, client.ContainerKillOptions{Signal: "KILL"}); err != nil {
		t.Fatal(err)
	}
	res, err = b.Run([]byte("3 4\n"))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("after kill: status=%s reason=%q", res.Status, res.Reason)
	wantStatus(t, res, StatusIE)
	if _, err := b.Run([]byte("5 6\n")); err == nil {
		t.Fatal("dead batch was reused")
	}
	if _, err := sb.cli.ContainerInspect(context.Background(), b.id, client.ContainerInspectOptions{}); err == nil {
		t.Fatal("dead batch container not removed")
	}
}

// Inputs larger than the batch was sized for are rejected by judge-exec with
// an error frame: IE with judge-exec's message, and the batch ends.
func TestBatchOversizedInput(t *testing.T) {
	b := startBatch(t, compileFixture(t, "ok.py"), []string{"1 2\n"}, std)
	res, err := b.Run([]byte("1 2 3 4 5\n"))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("status=%s reason=%q", res.Status, res.Reason)
	wantStatus(t, res, StatusIE)
	if !strings.Contains(res.Reason, "exceeds size limit") {
		t.Fatalf("reason %q", res.Reason)
	}
	if _, err := b.Run([]byte("1 2\n")); err == nil {
		t.Fatal("batch reused after judge-exec error")
	}
}

// A fork bomb hitting the process limit in one batch test leaves judge-exec
// alive and the next test in the same container unaffected.
func TestBatchProcessLimit(t *testing.T) {
	res := runBatchFixture(t, "fork.cpp", []string{"", ""}, std)
	for i, r := range res {
		wantStatus(t, r, StatusOK)
		var started, failed int
		if _, err := fmt.Sscanf(strings.TrimSpace(r.Stdout), "started=%d failed=%d", &started, &failed); err != nil || failed == 0 {
			t.Fatalf("test %d: %q (%v)", i+1, r.Stdout, err)
		}
	}
}

// Nothing planted in one test survives into the next: /dev/shm (not even
// mounted under --ipc none), POSIX message queues, and System V shm/msg/sem.
// (Syscall-level and so language-independent: the C++ and Python probes
// cover C and Go too.)
func TestBatchCrossTestState(t *testing.T) {
	for _, f := range []string{"snoopipc.cpp", "snoopipc.py"} {
		t.Run(f, func(t *testing.T) {
			res := runBatchFixture(t, f, []string{"plant", "look", "look"}, std)
			for i, r := range res {
				wantStatus(t, r, StatusOK)
				if i > 0 && strings.Contains(r.Stdout, "FOUND") {
					t.Fatalf("test %d found state planted by test 1:\n%s", i+1, r.Stdout)
				}
			}
			if strings.Contains(res[0].Stdout, "plant /dev/shm ok") {
				t.Errorf("/dev/shm is writable despite --ipc none:\n%s", res[0].Stdout)
			}
			// The seccomp profile denies System V IPC and POSIX mqueues outright
			// (EPERM), under runc and under runsc --oci-seccomp: nothing can be
			// planted, so no reset can be missed.
			if f == "snoopipc.cpp" {
				for _, ch := range []string{"plant mqueue", "plant sysv shm", "plant sysv msg", "plant sysv sem"} {
					if !strings.Contains(res[0].Stdout, ch+" failed: Operation not permitted") {
						t.Errorf("%s was not denied by seccomp:\n%s", ch, res[0].Stdout)
					}
				}
			}
		})
	}
}
