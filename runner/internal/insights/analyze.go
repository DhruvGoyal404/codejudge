package insights

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

// Ladder is a problem's size ladder: <tests dir>/<slug>/ladder/ladder.json
// plus one input file per step, made by scripts/make-ladders.py from the
// private gen/ladder.py. Inputs are hidden data: never returned.
type Ladder struct {
	Label     string     `json:"label"` // what n means, e.g. "n = number of items"
	MaxN      float64    `json:"max_n"` // the statement's largest n
	Steps     []Step     `json:"steps"`
	Reference *Reference `json:"reference,omitempty"`
	dir       string
}

// Step is one size of the ladder.
type Step struct {
	N    float64 `json:"n"`
	File string  `json:"file"`
}

// Reference is the reference solution's measured class (make-ladders.py).
type Reference struct {
	Lang  string `json:"lang"`
	Class string `json:"class"`
}

// LoadLadder reads p's ladder; os.ErrNotExist if the problem has none.
func LoadLadder(p *problem.Problem) (*Ladder, error) {
	dir := filepath.Join(filepath.Dir(p.TestsDir), "ladder")
	b, err := os.ReadFile(filepath.Join(dir, "ladder.json"))
	if err != nil {
		return nil, err
	}
	var l Ladder
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, fmt.Errorf("ladder.json: %w", err)
	}
	if len(l.Steps) == 0 || !sort.SliceIsSorted(l.Steps, func(i, j int) bool { return l.Steps[i].N < l.Steps[j].N }) {
		return nil, fmt.Errorf("ladder.json: steps must be non-empty and ascending")
	}
	l.dir = dir
	return &l, nil
}

// Options bound one analysis.
type Options struct {
	Reps   int           // runs per size (median); default 3
	Budget time.Duration // total program CPU; default 20 s
	// Yield is called before every run; it may block (the worker waits while
	// judging is busy) and returns an error to abandon the analysis. paused
	// reports that it waited: the run then gets a fresh batch container, as a
	// long pause may outlast the old one's deadline.
	Yield func(context.Context) (paused bool, err error)
}

// Measured is one ladder size as the user sees it: medians only.
type Measured struct {
	N      float64 `json:"n"`
	CPUMs  int64   `json:"cpu_ms"`
	RSSKB  int64   `json:"rss_kb"`
	Status string  `json:"status"` // OK, or the run status that stopped the ladder
}

// Report is the outcome of an analysis. It holds no program output and no
// input, only sizes and measurements.
type Report struct {
	Status        string     `json:"status"` // ok, CE, or IE
	Reason        string     `json:"reason,omitempty"`
	Label         string     `json:"label"`
	Steps         []Measured `json:"steps"`
	BaselineCPUMs int64      `json:"baseline_cpu_ms"`
	BaselineRSSKB int64      `json:"baseline_rss_kb"`
	Time          Fit        `json:"time"`
	Memory        Fit        `json:"memory"`
	TimeLimitMs   int64      `json:"time_limit_ms"`
	MaxN          float64    `json:"max_n"`
	PredictedMs   int64      `json:"predicted_ms,omitempty"` // time fit extrapolated to MaxN, baseline included
	Reference     *Reference `json:"reference,omitempty"`
	StoppedBy     string     `json:"stopped_by,omitempty"` // why the ladder ended early
	CPUSpentMs    int64      `json:"cpu_spent_ms"`
}

// Measurement noise. A point's standard error is sqrt(J^2 + (rel*cost)^2):
// J is the language's startup jitter (empty program), rel the run-to-run
// spread of larger runs.
const (
	minJitterMs   = 2
	relCPU        = 0.03
	minJitterKB   = 512
	relRSS        = 0.03
	repeatOverMs  = 5   // repeat a size only once it costs this much over the startup
	jitWarmMs     = 100 // Java/JavaScript: fit only sizes with this much CPU over the startup
	baselineRuns  = 5
	defaultReps   = 3
	defaultBudget = 20 * time.Second
)

// Analyze compiles src and runs it on every ladder size in one batch
// container under the problem's limits, then fits time and memory growth.
func Analyze(ctx context.Context, sb *sandbox.Sandbox, p *problem.Problem, lad *Ladder, l lang.Lang, src []byte, opt Options) (*Report, error) {
	if opt.Reps <= 0 {
		opt.Reps = defaultReps
	}
	if opt.Budget <= 0 {
		opt.Budget = defaultBudget
	}
	lim := sandbox.Limits{TimeLimit: p.EffectiveTimeLimit(l.Name), MemoryMB: p.MemoryMB, LowPriority: true}
	rep := &Report{Status: "ok", Label: lad.Label, TimeLimitMs: lim.TimeLimit.Milliseconds(), MaxN: lad.MaxN, Reference: lad.Reference}

	base, err := baseline(ctx, sb, l, lim)
	if err != nil {
		return nil, err
	}
	rep.BaselineCPUMs, rep.BaselineRSSKB = base.cpu, base.rss

	compiled, cres, err := sb.Compile(ctx, l, src)
	if err != nil {
		return nil, err
	}
	if compiled == nil {
		rep.Status, rep.Reason = "CE", cres.Reason
		return rep, nil
	}
	inputs := make([][]byte, len(lad.Steps))
	maxIn, total := 0, 0
	for i, s := range lad.Steps {
		if inputs[i], err = os.ReadFile(filepath.Join(lad.dir, s.File)); err != nil {
			return nil, err
		}
		maxIn = max(maxIn, len(inputs[i]))
		total += len(inputs[i]) * opt.Reps
	}
	// A batch container runs at most sandbox.MaxTests programs (that bounds its
	// lifetime); a longer ladder continues in a fresh one.
	var b *sandbox.Batch
	runsLeft, used := len(lad.Steps)*opt.Reps, 0
	defer func() {
		if b != nil {
			b.Close()
		}
	}()
	run := func(input []byte) (*sandbox.Result, error) {
		if b == nil || used == sandbox.MaxTests || b.Dead() {
			if b != nil {
				b.Close()
			}
			var err error
			if b, err = sb.StartBatch(ctx, compiled, lim, min(runsLeft, sandbox.MaxTests), maxIn, total); err != nil {
				b = nil
				return nil, fmt.Errorf("start batch: %w", err)
			}
			used = 0
		}
		used++
		runsLeft--
		return b.Run(input)
	}

	jitter := math.Max(minJitterMs, base.sigma)
	floor := max(repeatOverMs, 3*int64(jitter))
	var spent time.Duration
	// once runs one size; ok is false when the program failed there (the
	// failed run is the ladder's last step) or the analysis must stop.
	once := func(i int) (res *sandbox.Result, err error) {
		if opt.Yield != nil {
			paused, err := opt.Yield(ctx)
			if err != nil {
				return nil, err
			}
			if paused && b != nil {
				b.Close()
				b = nil
			}
		}
		if res, err = run(inputs[i]); err != nil {
			return nil, err
		}
		spent += time.Duration(res.CPUMs) * time.Millisecond
		return res, nil
	}
	// Pass 1 climbs the ladder once and finds where it stops; later passes
	// repeat the sizes above the noise floor. Interleaving passes (instead of
	// repeating each size back to back) spreads a burst of background load
	// over different sizes, so the per-size median discards it.
	cpus := make([][]int64, len(lad.Steps))
	rsss := make([][]int64, len(lad.Steps))
	var failed *Measured
	done, prev := 0, -1
	for i, st := range lad.Steps {
		// While the curve is still flat, every other size is skipped: the
		// flat part needs few points, so a dense ladder costs little until
		// the cost starts to rise (where the density matters).
		if prev == i-1 && prev >= 0 && cpus[prev][0]-base.cpu < floor && i < len(lad.Steps)-1 {
			done = i + 1
			continue
		}
		prev = i
		res, err := once(i)
		if err != nil {
			return nil, err
		}
		if res.Status != sandbox.StatusOK {
			failed = &Measured{N: st.N, CPUMs: res.CPUMs, RSSKB: res.MaxRSSKB, Status: res.Status}
			rep.StoppedBy = res.Status
			break
		}
		cpus[i], rsss[i] = []int64{res.CPUMs}, []int64{res.MaxRSSKB}
		done = i + 1
		if spent >= opt.Budget {
			rep.StoppedBy = "budget"
			break
		}
	}
passes:
	for r := 1; r < opt.Reps && rep.StoppedBy != "budget"; r++ {
		for i := 0; i < done; i++ {
			if cpus[i] == nil || cpus[i][0]-base.cpu < floor || len(cpus[i]) < r {
				continue // under the floor: one run says all there is
			}
			res, err := once(i)
			if err != nil {
				return nil, err
			}
			if res.Status == sandbox.StatusOK { // a repeat that hits a limit under load is just dropped
				cpus[i], rsss[i] = append(cpus[i], res.CPUMs), append(rsss[i], res.MaxRSSKB)
			}
			if spent >= opt.Budget {
				break passes
			}
		}
	}
	for i := 0; i < done; i++ {
		if cpus[i] == nil {
			continue // skipped while flat
		}
		rep.Steps = append(rep.Steps, Measured{N: lad.Steps[i].N, CPUMs: median(cpus[i]), RSSKB: median(rsss[i]), Status: sandbox.StatusOK})
	}
	if failed != nil {
		rep.Steps = append(rep.Steps, *failed)
	}
	rep.CPUSpentMs = spent.Milliseconds()

	var tp, mp []Point
	for _, m := range rep.Steps {
		if m.Status != sandbox.StatusOK {
			continue
		}
		c, r := float64(m.CPUMs), float64(m.RSSKB)
		// JIT runtimes run a hot loop in the interpreter until it has done
		// enough iterations to be compiled, which flattens the curve at small
		// sizes: fit only sizes with enough of the program's own work.
		if !jitLangs[l.Name] || m.CPUMs-base.cpu >= jitWarmMs {
			tp = append(tp, Point{m.N, c, math.Hypot(jitter, relCPU*c)})
		}
		mp = append(mp, Point{m.N, r, math.Hypot(minJitterKB, relRSS*r)})
	}
	rep.Time, rep.Memory = Select(tp), Select(mp)
	if rep.StoppedBy != "" {
		// A ladder cut short by a limit never shows "too small to measure".
		for _, f := range []*Fit{&rep.Time, &rep.Memory} {
			if f.Class == Fast {
				f.Class, f.Reason = Unclear, "the program hit a limit before its growth showed"
			}
		}
	}
	if rep.Time.Class != Unclear && rep.Time.Class != Fast && lad.MaxN > 0 {
		rep.PredictedMs = int64(rep.Time.Predict(lad.MaxN))
	}
	return rep, nil
}

func median(v []int64) int64 {
	s := append([]int64(nil), v...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

var jitLangs = map[string]bool{"java": true, "javascript": true}

// emptyPrograms measure each language's startup cost.
var emptyPrograms = map[string]string{
	"c":          "int main(void) { return 0; }\n",
	"cpp":        "int main() { return 0; }\n",
	"go":         "package main\n\nfunc main() {}\n",
	"python":     "pass\n",
	"java":       "public class Main { public static void main(String[] a) {} }\n",
	"javascript": "\n",
}

type base struct {
	cpu, rss int64
	sigma    float64 // standard deviation of the startup CPU time
}

var (
	baseMu    sync.Mutex
	baseCache = map[string]base{} // per language and memory limit (runtimes size their heap by it)
)

func baseline(ctx context.Context, sb *sandbox.Sandbox, l lang.Lang, lim sandbox.Limits) (base, error) {
	key := fmt.Sprintf("%s/%d", l.Name, lim.MemoryMB)
	baseMu.Lock()
	b, ok := baseCache[key]
	baseMu.Unlock()
	if ok {
		return b, nil
	}
	src, ok := emptyPrograms[l.Name]
	if !ok {
		return base{}, fmt.Errorf("no empty program for %s", l.Name)
	}
	c, cres, err := sb.Compile(ctx, l, []byte(src))
	if err != nil {
		return base{}, err
	}
	if c == nil {
		return base{}, fmt.Errorf("empty %s program: %s", l.Name, cres.Reason)
	}
	bt, err := sb.StartBatch(ctx, c, lim, baselineRuns, 1, baselineRuns)
	if err != nil {
		return base{}, err
	}
	defer bt.Close()
	var cpus, rsss []int64
	for i := 0; i < baselineRuns; i++ {
		res, err := bt.Run([]byte("\n"))
		if err != nil {
			return base{}, err
		}
		if res.Status != sandbox.StatusOK {
			return base{}, fmt.Errorf("empty %s program: %s %s", l.Name, res.Status, res.Reason)
		}
		cpus, rsss = append(cpus, res.CPUMs), append(rsss, res.MaxRSSKB)
	}
	sort.Slice(cpus, func(i, j int) bool { return cpus[i] < cpus[j] })
	// The range of 5 normal samples is about 2.33 standard deviations.
	b = base{cpu: median(cpus), rss: median(rsss), sigma: float64(cpus[len(cpus)-1]-cpus[0]) / 2.33}
	baseMu.Lock()
	baseCache[key] = b
	baseMu.Unlock()
	return b, nil
}

// Hash identifies the ladder's content (label, sizes and every input byte),
// not its recorded reference: the cache key for analyses, and the check the
// worker makes that its disk matches what the database imported.
func (l *Ladder) Hash() (string, error) {
	h := sha256.New()
	fmt.Fprintf(h, "label %q max %g\n", l.Label, l.MaxN)
	for _, s := range l.Steps {
		b, err := os.ReadFile(filepath.Join(l.dir, s.File))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "step %g %d\n", s.N, len(b))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
