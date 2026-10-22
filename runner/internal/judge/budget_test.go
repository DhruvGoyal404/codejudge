package judge

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/checker"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

func TestTotalBudget(t *testing.T) {
	for _, c := range []struct {
		tests   int
		perTest time.Duration
		want    time.Duration
	}{
		{45, time.Second, 45 * time.Second},      // under the cap: the sum of per-test limits
		{45, 2 * time.Second, MaxTotalCPU},       // 90 s -> capped
		{45, 10 * time.Second, MaxTotalCPU},      // billboard-strip Python: 450 s -> capped
		{2, 500 * time.Millisecond, time.Second}, // tiny problem
	} {
		if got := TotalBudget(c.tests, c.perTest); got != c.want {
			t.Errorf("TotalBudget(%d, %v) = %v, want %v", c.tests, c.perTest, got, c.want)
		}
	}
}

// fakeProblem writes n tests whose expected output is "ok".
func fakeProblem(t *testing.T, n int) *problem.Problem {
	dir := t.TempDir()
	p := &problem.Problem{Checker: checker.Spec{Type: "tokens"}}
	for i := 1; i <= n; i++ {
		in, out := filepath.Join(dir, fmt.Sprintf("%02d.in", i)), filepath.Join(dir, fmt.Sprintf("%02d.out", i))
		if err := os.WriteFile(in, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(out, []byte("ok\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		p.Tests = append(p.Tests, problem.Test{Name: fmt.Sprintf("%02d", i), Sample: i <= 2, InputPath: in, OutputPath: out})
	}
	return p
}

// fakeRunner answers every test correctly, using cpu and wall ms per test.
func fakeRunner(cpu, wall int64, runs *int) *runner {
	return &runner{
		run: func([]byte) (*sandbox.Result, bool) {
			*runs++
			return &sandbox.Result{Status: sandbox.StatusOK, Stdout: "ok\n", CPUMs: cpu, WallMs: wall}, true
		},
		close: func() {},
	}
}

func judgeFake(t *testing.T, tests int, cpu, wall int64, budget time.Duration, opt Options) (*SubmissionResult, int) {
	t.Helper()
	runs := 0
	sr := &SubmissionResult{}
	if err := runTests(sr, fakeProblem(t, tests), fakeRunner(cpu, wall, &runs), budget, opt, func(string, int) {}); err != nil {
		t.Fatal(err)
	}
	return sr, runs
}

func TestBudgetStopsASlowButCorrectSubmission(t *testing.T) {
	// 45 tests at 9.9 s CPU each would hold the worker for ~7.5 minutes; the
	// 60 s budget runs out during test 7 (6 x 9.9 = 59.4 s, 7 x 9.9 = 69.3 s).
	sr, runs := judgeFake(t, 45, 9900, 10000, TotalBudget(45, 10*time.Second), Options{})
	if sr.Verdict != TLE || sr.FailedTest != "07" || runs != 7 || sr.TestsRun != 7 {
		t.Fatalf("verdict %s at %q after %d runs (%d recorded), want TLE at 07 after 7", sr.Verdict, sr.FailedTest, runs, sr.TestsRun)
	}
	if !strings.Contains(sr.Reason, "total time budget exceeded") {
		t.Fatalf("reason %q", sr.Reason)
	}
	for _, d := range sr.Tests[:6] {
		if d.Verdict != AC {
			t.Fatalf("test %s: %s, want AC before the budget ran out", d.Name, d.Verdict)
		}
	}
}

func TestBudgetStopsASleepingSubmission(t *testing.T) {
	// Almost no CPU but most of the wall limit on every test: the wall budget
	// (twice the CPU budget, 120 s) runs out during test 7 (7 x 19 s = 133 s).
	sr, runs := judgeFake(t, 45, 10, 19000, TotalBudget(45, 10*time.Second), Options{})
	if sr.Verdict != TLE || sr.FailedTest != "07" || runs != 7 {
		t.Fatalf("verdict %s at %q after %d runs, want TLE at 07 after 7", sr.Verdict, sr.FailedTest, runs)
	}
}

func TestBudgetLeavesAFastSubmissionAlone(t *testing.T) {
	// Every test right at its 1 s limit uses exactly the sum of the limits: AC.
	sr, runs := judgeFake(t, 45, 1000, 1050, TotalBudget(45, time.Second), Options{})
	if sr.Verdict != AC || runs != 45 || sr.TestsRun != 45 {
		t.Fatalf("verdict %s after %d runs, want AC after 45", sr.Verdict, runs)
	}
}

func TestBudgetEndsRunAll(t *testing.T) {
	// --run-all keeps going after failures, but not past the budget.
	sr, runs := judgeFake(t, 45, 9900, 10000, TotalBudget(45, 10*time.Second), Options{RunAll: true})
	if sr.Verdict != TLE || runs != 7 {
		t.Fatalf("verdict %s after %d runs, want TLE after 7", sr.Verdict, runs)
	}
}
