//go:build integration

package judge

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
)

// TestBenchSubmissions measures full submission latency (compile + every
// test, host side) for each seed problem's references, batch mode vs the
// Phase 1 per-test-container mode. Opt-in, it takes a while:
//
//	JUDGE_BENCH=1 go test -p 1 -tags integration -run TestBenchSubmissions -count=1 -v -timeout 90m ./internal/judge/
//
// Optional comma-separated filters: JUDGE_BENCH_PROBLEMS, JUDGE_BENCH_FILES
// (ref.cpp,ref.py,ref.java,ref.js), JUDGE_BENCH_MODES (batch,per-test). Never run this at the
// same time as an integration suite on the dev machine.
func TestBenchSubmissions(t *testing.T) {
	if os.Getenv("JUDGE_BENCH") != "1" {
		t.Skip("set JUDGE_BENCH=1")
	}
	const runs = 10
	dir := problemsDir(t)
	for _, slug := range filter("JUDGE_BENCH_PROBLEMS", seedProblems) {
		p, err := problem.Load(filepath.Join(dir, slug))
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range filter("JUDGE_BENCH_FILES", []string{"ref.cpp", "ref.py", "ref.java", "ref.js"}) {
			for _, mode := range filter("JUDGE_BENCH_MODES", []string{ModeBatch, ModePerTest}) {
				var total, compile []time.Duration
				for i := 0; i < runs; i++ {
					start := time.Now()
					res := judgeFile(t, p, file, Options{Mode: mode})
					el := time.Since(start)
					if res.Verdict != AC {
						t.Fatalf("%s/%s %s run %d: %s %s", slug, file, mode, i, res.Verdict, res.Reason)
					}
					total = append(total, el)
					compile = append(compile, time.Duration(res.CompileMs)*time.Millisecond)
				}
				t.Logf("BENCH %-16s %-7s %-8s tests=%d  total p50=%-7v p95=%-7v min=%-7v max=%-7v  compile p50=%v",
					slug, file, mode, len(p.Tests), pct(total, 0.5), pct(total, 0.95), pct(total, 0), pct(total, 1), pct(compile, 0.5))
			}
		}
	}
}

func pct(d []time.Duration, q float64) time.Duration {
	s := append([]time.Duration(nil), d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[int(q*float64(len(s)-1)+0.5)].Round(10 * time.Millisecond)
}

// filter keeps the items listed in env var name (all if unset).
func filter(name string, all []string) []string {
	v := os.Getenv(name)
	if v == "" {
		return all
	}
	keep := map[string]bool{}
	for _, s := range strings.Split(v, ",") {
		keep[strings.TrimSpace(s)] = true
	}
	var out []string
	for _, s := range all {
		if keep[s] {
			out = append(out, s)
		}
	}
	return out
}
