//go:build integration

// Seed-problem integration tests: require Docker and built images.
//
//	go test -tags integration -count=1 -v ./internal/judge/
package judge

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

var sb *sandbox.Sandbox

func TestMain(m *testing.M) {
	ctx := context.Background()
	seccomp, err := sandbox.FindRepoFile("sandbox/seccomp/default.json")
	must(err)
	lock, err := sandbox.FindRepoFile("sandbox/images/images.lock.json")
	must(err)
	sb, err = sandbox.New(ctx, sandbox.Options{SeccompPath: seccomp, ImagesLockPath: lock, Runtime: os.Getenv("JUDGE_TEST_RUNTIME")})
	must(err)
	code := m.Run()
	// Only this process's containers: other suites may run concurrently.
	if n, err := sb.OwnContainers(ctx); err != nil || n != 0 {
		fmt.Printf("FAIL: %d judge.managed containers left by this process (%v)\n", n, err)
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

var seedProblems = []string{"ledger-total", "range-ledger", "courier-grid", "rising-towers", "farthest-beacons"}

// problemsDir is the public problems/ directory. Tests that judge the seed
// problems need their hidden tests and solutions (the private problems repo,
// $CODEJUDGE_PROBLEMS_TESTS_DIR); without them they skip.
func problemsDir(t *testing.T) string {
	t.Helper()
	p, err := sandbox.FindRepoFile("problems/ledger-total/problem.yaml")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(filepath.Dir(p))
	if _, err := problem.Load(filepath.Join(dir, "ledger-total")); err != nil && errors.Is(err, fs.ErrNotExist) {
		t.Skipf("hidden tests not available (set %s to a checkout of the private problems repo): %v", problem.TestsRootEnv, err)
	}
	return dir
}

func judgeFile(t *testing.T, p *problem.Problem, file string, opt Options) *SubmissionResult {
	t.Helper()
	name := "cpp"
	if filepath.Ext(file) == ".py" {
		name = "python"
	}
	l, err := lang.Get(name)
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(filepath.Join(p.SolutionsDir(), file))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	res, err := Judge(ctx, sb, p, l, src, opt)
	if err != nil {
		t.Fatalf("Judge(%s/%s): %v", p.ID, file, err)
	}
	t.Logf("%s/%s [%s] -> %s (test %s idx %d sample=%v %q) tests %d/%d max_cpu=%dms/%dms max_rss=%dKB compile=%dms total=%dms",
		p.ID, file, res.Mode, res.Verdict, res.FailedTest, res.FailedTestIndex, res.FailedIsSample, res.Reason,
		res.TestsRun, res.TestsTotal, res.MaxCPUMs, res.TimeLimitMs, res.MaxRSSKB, res.CompileMs, res.TotalMs)
	return res
}

func TestSeedProblems(t *testing.T) {
	dir := problemsDir(t)
	for _, slug := range seedProblems {
		t.Run(slug, func(t *testing.T) {
			p, err := problem.Load(filepath.Join(dir, slug))
			if err != nil {
				t.Fatal(err)
			}
			if n := len(p.Tests) - len(p.Samples); len(p.Samples) != 2 || n < 8 || n > 15 {
				t.Fatalf("%d samples / %d hidden tests", len(p.Samples), n)
			}
			for _, c := range []struct{ file, want string }{
				{"ref.cpp", AC}, {"ref.py", AC}, {"wrong.cpp", WA}, {"slow.cpp", TLE},
			} {
				res := judgeFile(t, p, c.file, Options{})
				if res.Verdict != c.want {
					t.Errorf("%s: verdict %s (%s), want %s", c.file, res.Verdict, res.Reason, c.want)
				}
				if c.file == "ref.py" {
					// Clear margin: the Python reference must use at most half of its
					// effective (multiplied) time limit on every test.
					if res.MaxCPUMs*2 > res.TimeLimitMs {
						t.Errorf("python reference max cpu %dms is not within 50%% of its %dms limit", res.MaxCPUMs, res.TimeLimitMs)
					}
				}
			}
		})
	}
}

// --run-all keeps going after failures; samples run first and are flagged.
func TestRunAllAndSampleFirst(t *testing.T) {
	p, err := problem.Load(filepath.Join(problemsDir(t), "range-ledger"))
	if err != nil {
		t.Fatal(err)
	}
	res := judgeFile(t, p, "wrong.cpp", Options{RunAll: true})
	if res.Verdict != WA || res.FailedTest != "01" || !res.FailedIsSample || res.FailedTestIndex != 1 {
		t.Fatalf("got %s at %s (idx %d, sample=%v)", res.Verdict, res.FailedTest, res.FailedTestIndex, res.FailedIsSample)
	}
	if res.TestsRun != res.TestsTotal {
		t.Fatalf("--run-all ran %d of %d tests", res.TestsRun, res.TestsTotal)
	}
	if !res.Tests[0].Sample || !res.Tests[1].Sample || res.Tests[0].Expected == "" {
		t.Fatal("samples must run first and include expected output")
	}
	for _, d := range res.Tests[2:] {
		if d.Stdout != "" || d.Expected != "" || d.Stderr != "" {
			t.Fatalf("hidden test %s leaked output in the result", d.Name)
		}
	}

	stop := judgeFile(t, p, "wrong.cpp", Options{})
	if stop.TestsRun != 1 {
		t.Fatalf("default mode should stop at the first failure, ran %d", stop.TestsRun)
	}
}
