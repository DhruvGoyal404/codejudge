// Package insights measures how a program's cost grows with its input size
// and names the complexity class that fits (docs/INSIGHTS.md).
package insights

import (
	"math"
	"sort"
)

// Model is one candidate growth class f(n).
type Model struct {
	Name string
	F    func(n float64) float64
}

// Models, in increasing order of growth.
var Models = []Model{
	{"1", func(float64) float64 { return 1 }},
	{"log n", func(n float64) float64 { return math.Log2(n) }},
	{"n", func(n float64) float64 { return n }},
	{"n log n", func(n float64) float64 { return n * math.Log2(n) }},
	{"n^2", func(n float64) float64 { return n * n }},
	{"n^3", func(n float64) float64 { return n * n * n }},
	{"2^(n/2)", func(n float64) float64 { return math.Exp2(n / 2) }}, // meet in the middle
	{"2^n", func(n float64) float64 { return math.Exp2(n) }},
}

// Point is one measured size: the median cost (startup included) and its
// standard error.
type Point struct {
	N     float64 `json:"n"`
	Cost  float64 `json:"cost"`
	Sigma float64 `json:"-"`
}

// Fit is the outcome of model selection.
type Fit struct {
	Class      string             `json:"class"`      // a model name, "a or b", Fast or Unclear
	Confidence float64            `json:"confidence"` // Akaike weight of Class (summed for "a or b")
	Weights    map[string]float64 `json:"weights,omitempty"`
	Reason     string             `json:"reason,omitempty"` // why Unclear or Fast
	Offset     float64            `json:"offset"`           // fitted startup cost a
	Scale      float64            `json:"scale"`            // fitted c in a + c*f(n)
	best       Model
}

// Unclear is the class reported when the data does not support a claim; Fast
// when growth is too small to measure at the sizes the problem allows.
const (
	Unclear = "unclear"
	Fast    = "fast"
)

const (
	minPoints     = 5   // fewer measured sizes: unclear
	minConfidence = 0.8 // Akaike weight needed to name one class (or an adjacent pair)
	// The growth the best model explains across the measured sizes must
	// exceed this many standard errors of the largest point; below it the
	// curve is flat and any class "fits".
	minRiseSigmas = 8
	// After rescaling by the best fit's reduced chi-square, a residual
	// scatter above this fraction of the rise means the curve has no clean shape.
	maxScatter = 0.15
	// A claim needs this many sizes whose fitted growth over the smallest size
	// is at least informSigmas of their own noise: a flat curve with a noisy
	// tail otherwise fakes super-linear growth.
	minInformative = 4
	informSigmas   = 3
)

// adjacent pairs that a ladder often can't tell apart; reported together.
var adjacent = [][2]string{{"n", "n log n"}, {"n^2", "n^3"}}

// alwaysPaired are never told apart: over the 3-4 decades a ladder spans, a
// log factor changes cost by about as much as noise and cache effects do
// (measured: the eval swapped them at 80-98% confidence).
var alwaysPaired = map[string]string{"n": "n or n log n", "n log n": "n or n log n"}

type fitted struct {
	m      Model
	a, c   float64
	chi2   float64
	params int
}

// fitModel solves weighted least squares for cost = a + c*f(n) (a only for
// the constant model). ok is false when the fit is not physical (c <= 0).
func fitModel(m Model, pts []Point) (fitted, bool) {
	if m.Name == "1" {
		var sw, swy float64
		for _, p := range pts {
			w := 1 / (p.Sigma * p.Sigma)
			sw, swy = sw+w, swy+w*p.Cost
		}
		a := swy / sw
		return fitted{m: m, a: a, chi2: chi2(pts, m, a, 0), params: 1}, true
	}
	var sw, sx, sy, sxx, sxy float64
	for _, p := range pts {
		w, x := 1/(p.Sigma*p.Sigma), m.F(p.N)
		sw, sx, sy, sxx, sxy = sw+w, sx+w*x, sy+w*p.Cost, sxx+w*x*x, sxy+w*x*p.Cost
	}
	det := sw*sxx - sx*sx
	if det <= 0 || math.IsInf(det, 0) || math.IsNaN(det) {
		return fitted{}, false
	}
	c := (sw*sxy - sx*sy) / det
	a := (sy - c*sx) / sw
	if c <= 0 {
		return fitted{}, false
	}
	return fitted{m: m, a: a, c: c, chi2: chi2(pts, m, a, c), params: 2}, true
}

func chi2(pts []Point, m Model, a, c float64) float64 {
	var s float64
	for _, p := range pts {
		d := (p.Cost - a - c*m.F(p.N)) / p.Sigma
		s += d * d
	}
	return s
}

// Select fits every model as cost = a + c*f(n) (a: startup and input parsing
// that doesn't grow) by weighted least squares and picks by AIC, with the
// chi-square rescaled by the best fit's reduced chi-square so that
// underestimated noise widens the weights instead of faking confidence.
func Select(pts []Point) Fit {
	pts = append([]Point(nil), pts...)
	sort.Slice(pts, func(i, j int) bool { return pts[i].N < pts[j].N })
	if len(pts) < minPoints {
		return Fit{Class: Unclear, Reason: "too few sizes were measured"}
	}
	var fs []fitted
	for _, m := range Models {
		if f, ok := fitModel(m, pts); ok {
			fs = append(fs, f)
		}
	}
	aic := func(f fitted) float64 { return f.chi2 + 2*float64(f.params) }
	best := fs[0]
	for _, f := range fs[1:] {
		if aic(f) < aic(best) {
			best = f
		}
	}
	m := float64(len(pts))
	s2 := math.Max(1, best.chi2/(m-float64(best.params)))
	w := map[string]float64{}
	var total float64
	for _, f := range fs {
		w[f.m.Name] = math.Exp(-(aic(f) - aic(best)) / (2 * s2))
		total += w[f.m.Name]
	}
	for k := range w {
		w[k] /= total
	}
	out := Fit{Class: best.m.Name, Confidence: w[best.m.Name], Weights: w, Offset: best.a, Scale: best.c, best: best.m}

	lo, hi := pts[0], pts[len(pts)-1]
	rise := best.c * (best.m.F(hi.N) - best.m.F(lo.N))
	if best.m.Name == "1" || best.m.Name == "log n" || rise < minRiseSigmas*hi.Sigma {
		// Reading n values is already linear: a flat or log-shaped curve means
		// the growth is below what the clock resolves at these sizes.
		out.Class, out.Reason = Fast, "the cost barely grows over the measured sizes"
		return out
	}
	informative := 0
	for _, p := range pts {
		if best.c*(best.m.F(p.N)-best.m.F(lo.N)) >= informSigmas*p.Sigma {
			informative++
		}
	}
	if informative < minInformative {
		out.Class, out.Reason = Unclear, "only the largest sizes rose above the noise"
		return out
	}
	if scatter := math.Sqrt(s2) * hi.Sigma / rise; scatter > maxScatter {
		out.Class, out.Reason = Unclear, "the measurements are too noisy to fit"
		return out
	}
	if pair, ok := alwaysPaired[out.Class]; ok {
		out.Class, out.Confidence = pair, w["n"]+w["n log n"]
		if out.Confidence < minConfidence {
			out.Class, out.Reason = Unclear, "no single class fits clearly better than the others"
		}
		return out
	}
	if out.Confidence >= minConfidence {
		// Memory-hierarchy effects steepen the top of a curve (a quadratic's
		// largest sizes can look cubic once the data outgrows the cache), so
		// n^2 vs n^3 also has to agree with the median local slope.
		if s, ok := medianSlope(pts, out.Offset); ok && ((out.Class == "n^3" && s < 2.5) || (out.Class == "n^2" && s > 2.5)) {
			out.Class, out.Confidence = "n^2 or n^3", w["n^2"]+w["n^3"]
		}
		return out
	}
	for _, a := range adjacent {
		if (a[0] == out.Class || a[1] == out.Class) && w[a[0]]+w[a[1]] >= minConfidence {
			out.Class, out.Confidence = a[0]+" or "+a[1], w[a[0]]+w[a[1]]
			return out
		}
	}
	out.Class, out.Reason = Unclear, "no single class fits clearly better than the others"
	return out
}

// Predict extrapolates the best model to size n (0 if there is none).
func (f Fit) Predict(n float64) float64 {
	if f.best.F == nil {
		return 0
	}
	return f.Offset + f.Scale*f.best.F(n)
}

// medianSlope is the median log-log slope between consecutive points of the
// cost net of the startup offset, over points where that net cost is
// clearly positive; ok is false with fewer than 3 such slopes.
func medianSlope(pts []Point, offset float64) (float64, bool) {
	var net []Point
	for _, p := range pts {
		if c := p.Cost - offset; c > 3*p.Sigma {
			net = append(net, Point{N: p.N, Cost: c})
		}
	}
	var slopes []float64
	for i := 1; i < len(net); i++ {
		if net[i].N > net[i-1].N {
			slopes = append(slopes, math.Log(net[i].Cost/net[i-1].Cost)/math.Log(net[i].N/net[i-1].N))
		}
	}
	if len(slopes) < 3 {
		return 0, false
	}
	sort.Float64s(slopes)
	return slopes[len(slopes)/2], true
}
