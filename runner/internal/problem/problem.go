// Package problem loads and validates on-disk problem packages:
//
//	problems/<slug>/problem.yaml
//	problems/<slug>/statement.md
//	problems/<slug>/tests/NN.in, NN.out
package problem

import (
	"bytes"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/DhruvGoyal404/codejudge/runner/internal/checker"
	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

// Global maxima a problem package may not exceed.
const (
	MaxTimeLimit     = 5 * time.Second // base time limit (before multiplier)
	MaxMultiplier    = 5.0
	MinMemoryMB      = 16
	MaxMemoryMB      = 1024
	MaxTests         = sandbox.MaxTests
	MaxInputBytes    = 16 << 20 // per test
	MaxExpectedBytes = 16 << 20 // per test
	MaxTotalBytes    = 64 << 20 // all .in + .out
)

// DefaultMultipliers apply to languages a problem does not list.
var DefaultMultipliers = map[string]float64{"cpp": 1.0, "python": 2.0}

var (
	slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	testRe = regexp.MustCompile(`^([0-9]{2,3})\.(in|out)$`)
)

// Problem is a validated problem package.
type Problem struct {
	Dir         string
	ID          string
	Title       string
	TimeLimit   time.Duration
	MemoryMB    int64
	Checker     checker.Spec
	Multipliers map[string]float64
	Samples     []string
	Statement   string
	Tests       []Test // samples first (in problem.yaml order), then the rest by name
}

// Test is one test case on disk.
type Test struct {
	Name       string
	Sample     bool
	InputPath  string
	OutputPath string
}

// Input reads the test input.
func (t Test) Input() ([]byte, error) { return os.ReadFile(t.InputPath) }

// Expected reads the expected output.
func (t Test) Expected() ([]byte, error) { return os.ReadFile(t.OutputPath) }

// EffectiveTimeLimit is the time limit for lang after its multiplier.
func (p *Problem) EffectiveTimeLimit(langName string) time.Duration {
	m, ok := p.Multipliers[langName]
	if !ok {
		m = 1
	}
	return time.Duration(math.Ceil(float64(p.TimeLimit) * m))
}

type rawProblem struct {
	ID             string             `yaml:"id"`
	Title          string             `yaml:"title"`
	TimeLimit      string             `yaml:"time_limit"`
	MemoryLimit    int64              `yaml:"memory_limit"`
	Checker        checker.Spec       `yaml:"checker"`
	TimeMultiplier map[string]float64 `yaml:"time_multiplier"`
	Samples        []string           `yaml:"samples"`
}

// Load reads and validates the problem package in dir.
func Load(dir string) (*Problem, error) {
	p, err := load(dir)
	if err != nil {
		return nil, fmt.Errorf("problem %s: %w", filepath.Base(dir), err)
	}
	return p, nil
}

func load(dir string) (*Problem, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "problem.yaml"))
	if err != nil {
		return nil, err
	}
	var rp rawProblem
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&rp); err != nil {
		return nil, fmt.Errorf("problem.yaml: %w", err)
	}

	slug := filepath.Base(filepath.Clean(dir))
	if !slugRe.MatchString(rp.ID) {
		return nil, fmt.Errorf("id %q must match %s", rp.ID, slugRe)
	}
	if rp.ID != slug {
		return nil, fmt.Errorf("id %q must equal directory name %q", rp.ID, slug)
	}
	if strings.TrimSpace(rp.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}
	tl, err := time.ParseDuration(rp.TimeLimit)
	if err != nil {
		return nil, fmt.Errorf("time_limit %q: %w", rp.TimeLimit, err)
	}
	if tl <= 0 || tl > MaxTimeLimit {
		return nil, fmt.Errorf("time_limit %v outside (0, %v]", tl, MaxTimeLimit)
	}
	if rp.MemoryLimit < MinMemoryMB || rp.MemoryLimit > MaxMemoryMB {
		return nil, fmt.Errorf("memory_limit %d MB outside [%d, %d]", rp.MemoryLimit, MinMemoryMB, MaxMemoryMB)
	}
	if err := rp.Checker.Validate(); err != nil {
		return nil, err
	}

	p := &Problem{Dir: dir, ID: rp.ID, Title: rp.Title, TimeLimit: tl, MemoryMB: rp.MemoryLimit, Checker: rp.Checker, Samples: rp.Samples, Multipliers: map[string]float64{}}
	for l, m := range DefaultMultipliers {
		p.Multipliers[l] = m
	}
	for l, m := range rp.TimeMultiplier {
		if _, err := lang.Get(l); err != nil {
			return nil, fmt.Errorf("time_multiplier: %w", err)
		}
		if m <= 0 || m > MaxMultiplier || math.IsNaN(m) {
			return nil, fmt.Errorf("time_multiplier[%s] = %v outside (0, %v]", l, m, MaxMultiplier)
		}
		p.Multipliers[l] = m
	}
	for l := range p.Multipliers {
		if eff := p.EffectiveTimeLimit(l); eff > sandbox.MaxEffectiveTimeLimit {
			return nil, fmt.Errorf("effective time limit for %s is %v > %v", l, eff, sandbox.MaxEffectiveTimeLimit)
		}
	}

	st, err := os.ReadFile(filepath.Join(dir, "statement.md"))
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(st)) == 0 {
		return nil, fmt.Errorf("statement.md is empty")
	}
	p.Statement = string(st)

	if err := p.loadTests(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Problem) loadTests() error {
	testsDir := filepath.Join(p.Dir, "tests")
	entries, err := os.ReadDir(testsDir)
	if err != nil {
		return err
	}
	ins, outs := map[string]string{}, map[string]string{}
	var total int64
	for _, e := range entries {
		m := testRe.FindStringSubmatch(e.Name())
		if m == nil || !e.Type().IsRegular() {
			return fmt.Errorf("tests/%s: unexpected entry (want NN.in / NN.out regular files)", e.Name())
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		path := filepath.Join(testsDir, e.Name())
		if m[2] == "in" {
			if info.Size() > MaxInputBytes {
				return fmt.Errorf("tests/%s: %d bytes > %d", e.Name(), info.Size(), MaxInputBytes)
			}
			ins[m[1]] = path
		} else {
			if info.Size() > MaxExpectedBytes {
				return fmt.Errorf("tests/%s: %d bytes > %d", e.Name(), info.Size(), MaxExpectedBytes)
			}
			outs[m[1]] = path
		}
		total += info.Size()
	}
	if total > MaxTotalBytes {
		return fmt.Errorf("tests total %d bytes > %d", total, MaxTotalBytes)
	}
	for n := range ins {
		if _, ok := outs[n]; !ok {
			return fmt.Errorf("tests/%s.in has no matching .out", n)
		}
	}
	for n := range outs {
		if _, ok := ins[n]; !ok {
			return fmt.Errorf("tests/%s.out has no matching .in", n)
		}
	}
	if len(ins) == 0 || len(ins) > MaxTests {
		return fmt.Errorf("%d tests; need 1..%d", len(ins), MaxTests)
	}

	isSample := map[string]bool{}
	for _, s := range p.Samples {
		if _, ok := ins[s]; !ok {
			return fmt.Errorf("sample %q has no tests/%s.in", s, s)
		}
		if isSample[s] {
			return fmt.Errorf("sample %q listed twice", s)
		}
		isSample[s] = true
		p.Tests = append(p.Tests, Test{Name: s, Sample: true, InputPath: ins[s], OutputPath: outs[s]})
	}
	var rest []string
	for n := range ins {
		if !isSample[n] {
			rest = append(rest, n)
		}
	}
	sort.Strings(rest)
	for _, n := range rest {
		p.Tests = append(p.Tests, Test{Name: n, InputPath: ins[n], OutputPath: outs[n]})
	}
	return nil
}
