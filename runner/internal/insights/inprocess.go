package insights

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

// JIT runtimes (Java, JavaScript) are measured inside ONE process: a harness
// calls the program once per ladder size after warm-up calls, timing each
// call with the thread's (Java) or process's (Node) CPU time. A fresh process
// per size would time mostly the interpreter and the JIT warming up, which
// flattens the curve (docs/INSIGHTS.md). The run is an ordinary sandboxed run
// under the problem's memory limit and the largest allowed CPU limit; the
// per-size time limit is checked by the harness. If the harness can't run the
// program (it exits, reads stdin asynchronously, or fails), Analyze falls back
// to one process per size.

//go:embed harness_java.txt
var harnessJava string

//go:embed harness_js.txt
var harnessJS string

var (
	javaMainDecl = regexp.MustCompile(`\bpublic\s+(final\s+)?class\s+Main\b`)
	javaMainRef  = regexp.MustCompile(`\bMain\b`)
	asyncStdin   = regexp.MustCompile(`process\.stdin|readline|process\.exit|require\(["']worker_threads`)
	javaExit     = regexp.MustCompile(`System\.exit|Runtime\.getRuntime\(\)\.(exit|halt)`)
)

const (
	maxHarnessInput = 15 << 20 // under the sandbox's 16 MiB stdin cap
	// In-process CPU clocks tick in 10 ms steps inside the sandbox (measured
	// on gVisor): a few-tick curve is a staircase, not a shape. Only sizes of
	// at least minTicks ticks are fitted, and the noise includes quantization.
	clockTickMs = 10
	minTicks    = 3
)

// harnessSource wraps src for the in-process harness; ok is false when the
// program can't be called repeatedly in one process.
func harnessSource(l lang.Lang, src string) (string, bool) {
	switch l.Name {
	case "java":
		if !javaMainDecl.MatchString(src) || javaExit.MatchString(src) {
			return "", false
		}
		user := javaMainRef.ReplaceAllString(javaMainDecl.ReplaceAllString(src, "class Main"), "UserMain")
		return user + strings.Replace(harnessJava, "class InsightsHarnessMain", "public class Main", 1), true
	case "javascript":
		if asyncStdin.MatchString(src) {
			return "", false
		}
		lit, _ := json.Marshal(src)
		return "const USER_SOURCE = " + string(lit) + ";\n" + harnessJS, true
	}
	return "", false
}

// harnessInput frames the ladder inputs: count, per-size limit (ns), reps,
// then each input as "<length>\n<bytes>". Sizes that don't fit the stdin cap
// are left out (the largest ones).
func harnessInput(inputs [][]byte, limit time.Duration, reps int) ([]byte, int) {
	var body bytes.Buffer
	n := 0
	for _, in := range inputs {
		if body.Len()+len(in)+16 > maxHarnessInput {
			break
		}
		fmt.Fprintf(&body, "%d\n", len(in))
		body.Write(in)
		n++
	}
	return append([]byte(fmt.Sprintf("%d\n%d\n%d\n", n, limit.Nanoseconds(), reps)), body.Bytes()...), n
}

var errNoHarness = errors.New("program can't run under the in-process harness")

// analyzeInProcess measures every size in one sandboxed process (see above).
func analyzeInProcess(ctx context.Context, sb *sandbox.Sandbox, p *problem.Problem, lad *Ladder, l lang.Lang, src []byte, opt Options) (*Report, error) {
	wrapped, ok := harnessSource(l, string(src))
	if !ok {
		return nil, errNoHarness
	}
	inputs := make([][]byte, len(lad.Steps))
	for i, s := range lad.Steps {
		var err error
		if inputs[i], err = os.ReadFile(filepath.Join(lad.dir, s.File)); err != nil {
			return nil, err
		}
	}
	perSize := p.EffectiveTimeLimit(l.Name)
	stdin, used := harnessInput(inputs, perSize, opt.Reps)
	if opt.Yield != nil {
		if err := opt.Yield(ctx, nil); err != nil {
			return nil, err
		}
	}
	lim := sandbox.Limits{TimeLimit: sandbox.MaxEffectiveTimeLimit, MemoryMB: p.MemoryMB, LowPriority: true}
	res, err := sb.Execute(ctx, l, []byte(wrapped), stdin, lim)
	if err != nil {
		return nil, err
	}
	if res.Status == sandbox.StatusCE {
		return nil, fmt.Errorf("%w: harness did not compile", errNoHarness)
	}
	// Parse what the harness printed before it finished or was stopped.
	cpus := make([][]int64, used)
	stoppedAt := -1
	done := false
	sc := bufio.NewScanner(strings.NewReader(res.Stdout))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		switch {
		case len(f) == 3 && f[0] == "STEP":
			i, e1 := strconv.Atoi(f[1])
			ns, e2 := strconv.ParseFloat(f[2], 64)
			if e1 != nil || e2 != nil || i < 0 || i >= used || ns < 0 {
				return nil, fmt.Errorf("%w: bad harness line %q", errNoHarness, sc.Text())
			}
			cpus[i] = append(cpus[i], int64(math.Round(ns/1e6)))
		case len(f) == 2 && f[0] == "LIMIT":
			stoppedAt, _ = strconv.Atoi(f[1])
		case len(f) == 1 && f[0] == "DONE":
			done = true
		}
	}
	rep := &Report{Status: "ok", Method: "in-process", Label: lad.Label, TimeLimitMs: perSize.Milliseconds(), BaseLimitMs: p.TimeLimit.Milliseconds(), Language: l.Name, MaxN: lad.MaxN, Reference: lad.Reference}
	var tp []Point
	for i := 0; i < used; i++ {
		if len(cpus[i]) == 0 {
			break
		}
		st := Measured{N: lad.Steps[i].N, CPUMs: median(cpus[i]), RSSKB: res.MaxRSSKB, Status: sandbox.StatusOK}
		if i == stoppedAt {
			st.Status, rep.StoppedBy = sandbox.StatusTLE, sandbox.StatusTLE
		} else if st.CPUMs >= minTicks*clockTickMs {
			c := float64(st.CPUMs)
			tp = append(tp, Point{st.N, c, math.Hypot(clockTickMs/math.Sqrt(3), relCPU*c)})
		}
		rep.Steps = append(rep.Steps, st)
		rep.CPUSpentMs += st.CPUMs * int64(len(cpus[i]))
	}
	if !done && stoppedAt < 0 {
		if len(rep.Steps) == 0 || res.Status == sandbox.StatusRE || res.Status == sandbox.StatusMLE {
			return nil, fmt.Errorf("%w: %s %s", errNoHarness, res.Status, res.Reason)
		}
		rep.StoppedBy = res.Status // the run's overall CPU cap ended the ladder
	}
	rep.Time = Select(tp)
	if rep.StoppedBy == "" && len(tp) == 0 {
		rep.Time = Fit{Class: Fast, Reason: fmt.Sprintf("under %d ms at every size: too little to measure growth", minTicks*clockTickMs)}
	}
	rep.Memory = Fit{Class: Unclear, Reason: "one process for every size: peak memory is shared"}
	if rep.StoppedBy != "" && rep.Time.Class == Fast {
		rep.Time.Class, rep.Time.Reason = Unclear, "the program hit a limit before its growth showed"
	}
	if rep.Time.Class != Unclear && rep.Time.Class != Fast && lad.MaxN > 0 {
		rep.PredictedMs = int64(rep.Time.Predict(lad.MaxN))
	}
	return rep, nil
}
