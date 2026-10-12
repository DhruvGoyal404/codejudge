//go:build integration

package sandbox

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
)

// TestBenchOverhead measures per-test-case overhead (container create ->
// result, host side) for an already-compiled C++ program and for Python.
// Runs sequentially so the numbers are per-testcase latency, not throughput.
//
//	go test -tags integration -run TestBenchOverhead -count=1 -v ./internal/sandbox/
func TestBenchOverhead(t *testing.T) {
	if testing.Short() {
		t.Skip("benchmark")
	}
	const runs = 20
	ctx := context.Background()
	lim := Limits{TimeLimit: 2 * time.Second, MemoryMB: 256}

	for _, name := range []string{"cpp", "python"} {
		l, _ := lang.Get(name)
		src := fixture(t, map[string]string{"cpp": "ok.cpp", "python": "ok.py"}[name])
		c, cres, err := sb.Compile(ctx, l, src)
		if err != nil || c == nil {
			t.Fatalf("compile %s: %v %+v", name, err, cres)
		}
		payload := 0
		for _, f := range c.Files {
			payload += len(f.Data)
		}
		t.Logf("BENCH %-6s run payload (artifact/source) = %d bytes", name, payload)
		var samples []time.Duration
		for i := 0; i < runs; i++ {
			start := time.Now()
			res, err := sb.Run(ctx, c, []byte("40 2\n"), lim)
			el := time.Since(start)
			if err != nil || res.Status != StatusOK {
				t.Fatalf("%s run %d: %v %+v", name, i, err, res)
			}
			samples = append(samples, el)
		}
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		p := func(q float64) time.Duration { return samples[int(q*float64(len(samples)-1)+0.5)] }
		t.Logf("BENCH %-6s runs=%d compile=%dms  p50=%v p95=%v min=%v max=%v",
			name, runs, cres.CompileMs, p(0.50).Round(time.Millisecond), p(0.95).Round(time.Millisecond),
			samples[0].Round(time.Millisecond), samples[len(samples)-1].Round(time.Millisecond))
	}
}
