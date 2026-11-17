package insights

import (
	"math"
	"math/rand"
	"strings"
	"testing"
)

// curve makes points a + c*f(n), scaled so the largest size costs top ms,
// with startup offset a, additive jitter j and relative noise rel.
func curve(model string, sizes []float64, top, a, j, rel float64, seed int64) []Point {
	r := rand.New(rand.NewSource(seed))
	var f func(float64) float64
	for _, m := range Models {
		if m.Name == model {
			f = m.F
		}
	}
	c := top / f(sizes[len(sizes)-1])
	var pts []Point
	for _, n := range sizes {
		v := c * f(n) * (1 + rel*(2*r.Float64()-1))
		cost := a + v + j*(2*r.Float64()-1)
		pts = append(pts, Point{N: n, Cost: cost, Sigma: math.Hypot(j, relCPU*cost)})
	}
	return pts
}

func geometric(lo, hi float64, k int) []float64 {
	var s []float64
	for i := 0; i < k; i++ {
		s = append(s, lo*math.Pow(hi/lo, float64(i)/float64(k-1)))
	}
	return s
}

var ladder = geometric(10, 1e5, 20)

func TestSelectClean(t *testing.T) {
	for _, c := range []struct {
		model string
		sizes []float64
	}{
		{"n", ladder}, {"n log n", ladder}, {"n^2", ladder}, {"n^3", ladder},
		{"2^n", []float64{10, 12, 14, 16, 18, 20, 22, 24}},
		{"2^(n/2)", []float64{10, 14, 18, 22, 26, 30, 34, 36}},
	} {
		f := Select(curve(c.model, c.sizes, 800, 40, 0, 0, 1))
		want := c.model
		if p, ok := alwaysPaired[want]; ok {
			want = p
		}
		if f.Class != want || f.Confidence < 0.99 {
			t.Errorf("%s: got %q (%.3f) %s", c.model, f.Class, f.Confidence, f.Reason)
		}
	}
}

// Realistic noise (Python-like startup 45 ms, jitter 10 ms, 5% spread): each
// class is named or hedged as a pair containing it; never confidently wrong.
func TestSelectNoisy(t *testing.T) {
	for _, model := range []string{"n", "n log n", "n^2", "n^3"} {
		named := 0
		for seed := int64(1); seed <= 40; seed++ {
			f := Select(curve(model, ladder, 900, 45, 10, 0.05, seed))
			claimed := f.Class != Unclear && f.Class != Fast
			if claimed && !strings.Contains(" or "+f.Class+" or ", " or "+model+" or ") {
				t.Fatalf("%s seed %d: confidently wrong: %q (%.3f)", model, seed, f.Class, f.Confidence)
			}
			if f.Class == model || f.Class == alwaysPaired[model] {
				named++
			}
		}
		if model == "n^2" && named < 38 {
			t.Errorf("n^2 named only %d/40 times", named)
		}
	}
}

func TestSelectFastAndUnclear(t *testing.T) {
	// 6 ms of growth over a 40 ms startup with 5 ms jitter: too small to measure.
	if f := Select(curve("n", ladder, 6, 40, 5, 0, 1)); f.Class != Fast {
		t.Errorf("tiny growth: %q %s", f.Class, f.Reason)
	}
	if f := Select(curve("n^2", ladder[:4], 800, 40, 0, 0, 1)); f.Class != Unclear {
		t.Errorf("4 points: %q", f.Class)
	}
	// Noise as large as the signal.
	if f := Select(curve("n^2", ladder, 300, 40, 150, 0.6, 3)); f.Class != Unclear && f.Class != Fast {
		t.Errorf("wild noise: %q (%.3f)", f.Class, f.Confidence)
	}
}

func TestPredict(t *testing.T) {
	sizes := geometric(1e3, 1e5, 10)
	f := Select(curve("n^2", sizes, 1000, 40, 0, 0, 1))
	if got, want := f.Predict(2e5), 40+4*1000.0; math.Abs(got-want)/want > 1e-6 {
		t.Errorf("Predict(2e5) = %g, want %g", got, want)
	}
}

// A quadratic whose top sizes steepen (data outgrowing the cache) is hedged,
// not called cubic; a true cubic is still named.
func TestCacheSteepenedQuadraticIsHedged(t *testing.T) {
	var pts []Point
	for _, n := range ladder[8:] {
		c := 5 + 1e-7*n*n
		if n > 5e4 {
			c *= math.Pow(n/5e4, 0.6) // the last sizes slow down per operation (as measured: +0.5 to +1 slope)
		}
		pts = append(pts, Point{N: n, Cost: c, Sigma: math.Hypot(2, relCPU*c)})
	}
	if f := Select(pts); f.Class != "n^2" && f.Class != "n^2 or n^3" {
		t.Fatalf("steepened quadratic: %q (%.2f)", f.Class, f.Confidence)
	}
	if f := Select(curve("n^3", ladder, 900, 40, 0, 0.02, 1)); f.Class != "n^3" {
		t.Fatalf("cubic: %q", f.Class)
	}
}
