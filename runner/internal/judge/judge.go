// Package judge turns a submission into a verdict: compile, run every test of
// a problem (samples first), check outputs on the host, aggregate.
package judge

import (
	"context"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/DhruvGoyal404/codejudge/runner/internal/checker"
	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

// Submission verdicts.
const (
	AC  = "AC"
	WA  = "WA"
	CE  = "CE"
	RE  = "RE"
	TLE = "TLE"
	MLE = "MLE"
	OLE = "OLE"
	IE  = "IE"
)

// Execution modes.
const (
	ModeBatch   = "batch"    // one run container per submission (default)
	ModePerTest = "per-test" // Phase 1 style: a fresh container per test (benchmark baseline)
)

// Options control a judging run.
type Options struct {
	RunAll bool   // keep going after the first non-AC test (samples / "run code")
	Mode   string // ModeBatch (default) or ModePerTest
	// Progress, if set, is called before compiling ("compiling", 0, n) and
	// before each test ("testing", k, n). It must not block for long.
	Progress func(stage string, test, total int)
}

// Progress stages.
const (
	StageCompiling = "compiling"
	StageTesting   = "testing"
)

// sampleOutputCap bounds how much program/expected output is returned for
// samples. Output of hidden tests is never returned.
const sampleOutputCap = 4 << 10

// TestDetail is the outcome of one executed test.
type TestDetail struct {
	Index           int    `json:"index"` // 1-based execution order
	Name            string `json:"name"`
	Sample          bool   `json:"sample"`
	Verdict         string `json:"verdict"`
	Message         string `json:"message,omitempty"` // checker message or internal reason
	CPUMs           int64  `json:"cpu_ms"`
	WallMs          int64  `json:"wall_ms"`
	MaxRSSKB        int64  `json:"max_rss_kb"`
	ExitCode        int    `json:"exit_code"`
	Signal          int    `json:"signal"`
	RunMs           int64  `json:"run_ms"`
	Stdout          string `json:"stdout,omitempty"`           // samples only, at most sampleOutputCap bytes
	StdoutTruncated bool   `json:"stdout_truncated,omitempty"` // samples only
	Expected        string `json:"expected,omitempty"`         // samples only, capped
	Stderr          string `json:"stderr,omitempty"`           // samples only, capped
}

// SubmissionResult is the aggregate verdict.
type SubmissionResult struct {
	Problem         string       `json:"problem"`
	Lang            string       `json:"lang"`
	Mode            string       `json:"mode"`
	Verdict         string       `json:"verdict"`
	Reason          string       `json:"reason,omitempty"`
	FailedTest      string       `json:"failed_test,omitempty"`
	FailedTestIndex int          `json:"failed_test_index,omitempty"`
	FailedIsSample  bool         `json:"failed_is_sample,omitempty"`
	TestsRun        int          `json:"tests_run"`
	TestsTotal      int          `json:"tests_total"`
	MaxCPUMs        int64        `json:"max_cpu_ms"`
	MaxRSSKB        int64        `json:"max_rss_kb"`
	TimeLimitMs     int64        `json:"time_limit_ms"` // effective, after the language multiplier
	MemoryLimitMB   int64        `json:"memory_limit_mb"`
	CompileOutput   string       `json:"compile_output,omitempty"`
	CompileMs       int64        `json:"compile_ms"`
	TotalMs         int64        `json:"total_ms"` // compile + all tests, host side
	Tests           []TestDetail `json:"tests"`
}

// Judge compiles src and runs it against every test of p.
func Judge(ctx context.Context, sb *sandbox.Sandbox, p *problem.Problem, l lang.Lang, src []byte, opt Options) (*SubmissionResult, error) {
	if opt.Mode == "" {
		opt.Mode = ModeBatch
	}
	if opt.Mode != ModeBatch && opt.Mode != ModePerTest {
		return nil, fmt.Errorf("unknown mode %q", opt.Mode)
	}
	start := time.Now()
	lim := sandbox.Limits{TimeLimit: p.EffectiveTimeLimit(l.Name), MemoryMB: p.MemoryMB}
	sr := &SubmissionResult{Problem: p.ID, Lang: l.Name, Mode: opt.Mode, TestsTotal: len(p.Tests),
		TimeLimitMs: lim.TimeLimit.Milliseconds(), MemoryLimitMB: p.MemoryMB}
	defer func() { sr.TotalMs = time.Since(start).Milliseconds() }()

	progress := func(stage string, k int) {
		if opt.Progress != nil {
			opt.Progress(stage, k, len(p.Tests))
		}
	}
	progress(StageCompiling, 0)
	compiled, cres, err := sb.Compile(ctx, l, src)
	if err != nil {
		return nil, err
	}
	sr.CompileMs = cres.CompileMs
	if compiled == nil {
		sr.Verdict = verdictOf(cres.Status)
		sr.Reason = cres.Reason
		sr.CompileOutput = cres.CompileOutput
		return sr, nil
	}

	runner, err := newRunner(ctx, sb, compiled, p, lim, opt.Mode)
	if err != nil {
		return nil, err
	}
	defer runner.close()

	for i, t := range p.Tests {
		input, err := t.Input()
		if err != nil {
			return nil, err
		}
		progress(StageTesting, i+1)
		res, alive := runner.run(input)
		d := TestDetail{Index: i + 1, Name: t.Name, Sample: t.Sample, Verdict: verdictOf(res.Status), Message: res.Reason,
			CPUMs: res.CPUMs, WallMs: res.WallMs, MaxRSSKB: res.MaxRSSKB, ExitCode: res.ExitCode, Signal: res.Signal, RunMs: res.RunMs}
		var want []byte
		if d.Verdict == AC {
			if want, err = t.Expected(); err != nil {
				return nil, err
			}
			if c := checker.Check(p.Checker, []byte(res.Stdout), want); !c.OK {
				d.Verdict, d.Message = WA, c.Message
			}
		}
		if t.Sample {
			d.Stdout, d.StdoutTruncated = capBytes(res.Stdout)
			d.Stderr = capStr(res.Stderr)
			if want == nil {
				want, _ = t.Expected()
			}
			d.Expected = capStr(string(want))
		}
		sr.Tests = append(sr.Tests, d)
		sr.TestsRun++
		sr.MaxCPUMs = max(sr.MaxCPUMs, d.CPUMs)
		sr.MaxRSSKB = max(sr.MaxRSSKB, d.MaxRSSKB)
		if d.Verdict != AC && sr.Verdict == "" {
			sr.Verdict, sr.Reason = d.Verdict, d.Message
			sr.FailedTest, sr.FailedTestIndex, sr.FailedIsSample = d.Name, d.Index, d.Sample
		}
		if !alive || (d.Verdict != AC && !opt.RunAll) {
			break // a dead container ends the submission even with RunAll
		}
	}
	if sr.Verdict == "" {
		sr.Verdict = AC
	}
	return sr, nil
}

// verdictOf maps a sandbox run status to a submission verdict (OK -> AC,
// pending the checker).
func verdictOf(status string) string {
	switch status {
	case sandbox.StatusOK:
		return AC
	case sandbox.StatusCE:
		return CE
	case sandbox.StatusRE:
		return RE
	case sandbox.StatusTLE:
		return TLE
	case sandbox.StatusMLE:
		return MLE
	case sandbox.StatusOLE:
		return OLE
	default:
		return IE
	}
}

// capBytes returns at most sampleOutputCap bytes of s (cut on a UTF-8
// boundary) and whether anything was cut.
func capBytes(s string) (string, bool) {
	if len(s) <= sampleOutputCap {
		return s, false
	}
	cut := sampleOutputCap
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

func capStr(s string) string {
	if len(s) > sampleOutputCap {
		return s[:sampleOutputCap] + "...[truncated]"
	}
	return s
}

// runner abstracts batch vs per-test execution.
type runner struct {
	run   func(input []byte) (*sandbox.Result, bool) // result, container still usable
	close func()
}

func newRunner(ctx context.Context, sb *sandbox.Sandbox, c *sandbox.Compiled, p *problem.Problem, lim sandbox.Limits, mode string) (*runner, error) {
	if mode == ModePerTest {
		return &runner{
			run: func(input []byte) (*sandbox.Result, bool) {
				res, err := sb.Run(ctx, c, input, lim)
				if err != nil {
					return &sandbox.Result{Status: sandbox.StatusIE, Reason: err.Error()}, false
				}
				return res, true
			},
			close: func() {},
		}, nil
	}
	maxInput, totalInput := 0, 0
	for _, t := range p.Tests {
		in, err := t.Input()
		if err != nil {
			return nil, err
		}
		maxInput = max(maxInput, len(in))
		totalInput += len(in)
	}
	b, err := sb.StartBatch(ctx, c, lim, len(p.Tests), maxInput, totalInput)
	if err != nil {
		// Could not even start the run container: every test is IE.
		return &runner{
			run: func([]byte) (*sandbox.Result, bool) {
				return &sandbox.Result{Status: sandbox.StatusIE, Reason: "start batch: " + err.Error()}, false
			},
			close: func() {},
		}, nil
	}
	return &runner{
		run: func(input []byte) (*sandbox.Result, bool) {
			res, err := b.Run(input)
			if err != nil {
				return &sandbox.Result{Status: sandbox.StatusIE, Reason: err.Error()}, false
			}
			return res, !b.Dead()
		},
		close: b.Close,
	}, nil
}
