package insights

import (
	"math"
	"math/rand"
	"strings"
	"testing"
)

func curve(model string, sizes []float64, noise float64, seed int64) []Point {
	r := rand.New(rand.NewSource(seed))
	var lf func(float64) float64
	for _, m := range Models {
		if m.Name == model {
			lf = m.LogF
		}
	}
	var pts []Point
	for _, n := range sizes {
		pts = append(pts, Point{N: n, Cost: math.Exp(lf(n)-lf(sizes[0])) * 5 * (1 + noise*(2*r.Float64()-1))})
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

func TestSelectExact(t *testing.T) {
	poly := geometric(1e3, 1e6, 8)
	for _, c := range []struct {
		model string
		sizes []float64
	}{
		{"1", poly}, {"log n", poly}, {"n", poly}, {"n log n", poly}, {"n^2", poly}, {"n^3", poly},
		{"2^n", []float64{10, 12, 14, 16, 18, 20, 22, 24}},
	} {
		f := Select(curve(c.model, c.sizes, 0, 1))
		if f.Class != c.model || f.Confidence < 0.99 {
			t.Errorf("%s: got %q (%.3f)", c.model, f.Class, f.Confidence)
		}
	}
}

// With 10% noise each class is either named or, for the hard pairs, reported
// as the pair; a confident wrong class is the failure that matters.
func TestSelectNoisy(t *testing.T) {
	sizes := geometric(1e3, 1e6, 8)
	for _, model := range []string{"n", "n log n", "n^2", "n^3"} {
		for seed := int64(1); seed <= 50; seed++ {
			f := Select(curve(model, sizes, 0.10, seed))
			if f.Class != model && !strings.Contains(f.Class, " or ") && f.Class != Unclear {
				t.Fatalf("%s seed %d: confidently wrong: %q (%.3f)", model, seed, f.Class, f.Confidence)
			}
			if strings.Contains(f.Class, " or ") && !strings.Contains(f.Class, model) {
				t.Fatalf("%s seed %d: pair without the true class: %q", model, seed, f.Class)
			}
		}
	}
	for seed := int64(1); seed <= 50; seed++ { // quadratic vs linear is never ambiguous at 10%
		if f := Select(curve("n^2", sizes, 0.10, seed)); f.Class != "n^2" {
			t.Fatalf("n^2 seed %d: %q", seed, f.Class)
		}
	}
}

func TestSelectUnclear(t *testing.T) {
	sizes := geometric(1e3, 1e6, 8)
	if f := Select(curve("n", sizes[:3], 0, 1)); f.Class != Unclear {
		t.Errorf("3 points: %q", f.Class)
	}
	if f := Select(curve("n", geometric(1e3, 4e3, 6), 0, 1)); f.Class != Unclear {
		t.Errorf("narrow span: %q", f.Class)
	}
	if f := Select(curve("n", sizes, 1.9, 7)); f.Class != Unclear {
		t.Errorf("wild noise: %q (%.3f)", f.Class, f.Confidence)
	}
}

func TestPredict(t *testing.T) {
	sizes := geometric(1e3, 1e5, 6)
	f := Select(curve("n^2", sizes, 0, 1))
	got, want := f.Predict(1e6), 5*math.Pow(1e6/1e3, 2)
	if math.Abs(got-want)/want > 1e-6 {
		t.Errorf("Predict(1e6) = %g, want %g", got, want)
	}
}
