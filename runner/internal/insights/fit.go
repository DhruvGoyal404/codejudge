// Package insights measures how a program's cost grows with its input size
// and names the complexity class that fits (docs/INSIGHTS.md).
package insights

import (
	"math"
	"sort"
)

// Model is one candidate growth class. LogF is ln f(n), so 2^n never overflows.
type Model struct {
	Name string
	LogF func(n float64) float64
}

// Models, in increasing order of growth.
var Models = []Model{
	{"1", func(float64) float64 { return 0 }},
	{"log n", func(n float64) float64 { return math.Log(math.Log(n)) }},
	{"n", func(n float64) float64 { return math.Log(n) }},
	{"n log n", func(n float64) float64 { return math.Log(n) + math.Log(math.Log(n)) }},
	{"n^2", func(n float64) float64 { return 2 * math.Log(n) }},
	{"n^3", func(n float64) float64 { return 3 * math.Log(n) }},
	{"2^n", func(n float64) float64 { return n * math.Ln2 }},
}

// Point is one measured size: N and the cost net of the startup baseline.
type Point struct {
	N    float64 `json:"n"`
	Cost float64 `json:"cost"`
}

// Fit is the outcome of model selection.
type Fit struct {
	Class      string             `json:"class"`      // a model name, "a or b", or Unclear
	Confidence float64            `json:"confidence"` // Akaike weight of Class (summed for "a or b")
	Weights    map[string]float64 `json:"weights"`
	Reason     string             `json:"reason,omitempty"` // why Unclear
	LogC       float64            `json:"-"`                // scale of the best model
	best       Model
}

// Unclear is the class reported when the data does not support a claim.
const Unclear = "unclear"

const (
	minPoints     = 4    // fewer usable points: unclear
	minConfidence = 0.8  // Akaike weight needed to name one class (or an adjacent pair)
	maxScatter    = 0.25 // residual std of ln(cost): above it (about 28%) the curve is too noisy
	minSpan       = 8.0  // the usable sizes must span at least this ratio...
	minExpSpan    = 10.0 // ...or this difference, for exponential ladders
	maxExpN       = 64.0 // the largest n an exponential ladder can reach
)

// adjacent pairs that small ladders often can't tell apart; reported together.
var adjacent = [][2]string{{"1", "log n"}, {"n", "n log n"}}

// Select fits every model to the points by least squares on ln(cost), each
// with one free scale, and picks by AIC (equal parameter counts, so AIC
// reduces to the residual). Points must have Cost > 0 (the caller drops
// those under its noise floor).
func Select(pts []Point) Fit {
	pts = append([]Point(nil), pts...)
	sort.Slice(pts, func(i, j int) bool { return pts[i].N < pts[j].N })
	if len(pts) < minPoints {
		return Fit{Class: Unclear, Reason: "too few sizes above the noise floor"}
	}
	// Polynomial ladders span a ratio; exponential ones (n = 10..25) a difference.
	if lo, hi := pts[0].N, pts[len(pts)-1].N; hi/lo < minSpan && (hi > maxExpN || hi-lo < minExpSpan) {
		return Fit{Class: Unclear, Reason: "the measured sizes span too small a range"}
	}
	m := float64(len(pts))
	type res struct {
		model    Model
		logC, ss float64
	}
	var rs []res
	for _, md := range Models {
		var sum float64
		for _, p := range pts {
			sum += math.Log(p.Cost) - md.LogF(p.N)
		}
		logC := sum / m
		var ss float64
		for _, p := range pts {
			d := math.Log(p.Cost) - logC - md.LogF(p.N)
			ss += d * d
		}
		rs = append(rs, res{md, logC, math.Max(ss, 1e-12)})
	}
	best := rs[0]
	for _, r := range rs[1:] {
		if r.ss < best.ss {
			best = r
		}
	}
	// Akaike weights: w_i ∝ exp(-ΔAIC_i/2), ΔAIC_i = m ln(ss_i/ss_best).
	w := map[string]float64{}
	var total float64
	for _, r := range rs {
		w[r.model.Name] = math.Exp(-m / 2 * math.Log(r.ss/best.ss))
		total += w[r.model.Name]
	}
	for k := range w {
		w[k] /= total
	}
	f := Fit{Class: best.model.Name, Confidence: w[best.model.Name], Weights: w, LogC: best.logC, best: best.model}
	if scatter := math.Sqrt(best.ss / m); scatter > maxScatter {
		f.Class, f.Reason = Unclear, "the measurements are too noisy to fit"
		return f
	}
	if f.Confidence >= minConfidence {
		return f
	}
	for _, a := range adjacent {
		if (a[0] == f.Class || a[1] == f.Class) && w[a[0]]+w[a[1]] >= minConfidence {
			f.Class, f.Confidence = a[0]+" or "+a[1], w[a[0]]+w[a[1]]
			return f
		}
	}
	f.Class, f.Reason = Unclear, "no single class fits clearly better than the others"
	return f
}

// Predict extrapolates the best model's cost to size n (0 if unclear).
func (f Fit) Predict(n float64) float64 {
	if f.best.LogF == nil {
		return 0
	}
	return math.Exp(f.LogC + f.best.LogF(n))
}
