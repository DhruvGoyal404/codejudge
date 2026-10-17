// Package problem loads and validates on-disk problem packages.
//
// Public part (the codejudge repo):
//
//	problems/<slug>/problem.yaml
//	problems/<slug>/statement.md
//	problems/<slug>/samples/NN.in, NN.out   (the tests listed in samples:)
//
// Hidden part (the private problems repo, $CODEJUDGE_PROBLEMS_TESTS_DIR):
//
//	<slug>/tests/NN.in, NN.out              (every test, samples included)
//
// Without CODEJUDGE_PROBLEMS_TESTS_DIR the tests are read from
// problems/<slug>/tests (single-directory packages: fixtures, local work).
package problem

import (
	"bytes"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
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
	MaxTimeLimit  = 5 * time.Second // base time limit (before multiplier)
	MaxMultiplier = 5.0
	MinMemoryMB   = 16
	MaxMemoryMB   = 1024
	MaxTests      = sandbox.MaxTests
	MaxInputBytes = 16 << 20 // per test
	// MaxExpectedBytes: an expected output must fit the judge's stdout cap,
	// or every correct solution would get OLE on that test.
	MaxExpectedBytes = sandbox.DefaultOutputBytes // per test
	MaxTotalBytes    = 32 << 20                   // all .in + .out of one problem
	MaxTags          = 5
	// CatalogMinTests is the least number of tests a published problem has
	// (enforced by judge-admin check, not by Load: fixtures may have fewer).
	CatalogMinTests = 25
)

// Difficulties are the allowed values of difficulty: in problem.yaml.
var Difficulties = []string{"easy", "medium", "hard"}

// Tags is the controlled vocabulary for tags: in problem.yaml (the UI
// filters on these, so a typo must not create a new tag).
var Tags = []string{
	"arrays", "backtracking", "binary-search", "bit-manipulation", "bfs", "brute-force",
	"combinatorics", "constructive", "dfs", "dynamic-programming", "games", "geometry",
	"graphs", "greedy", "hashing", "heap", "implementation", "intervals", "math", "matrix",
	"number-theory", "prefix-sums", "queue", "recursion", "segment-tree", "shortest-paths",
	"simulation", "sliding-window", "sorting", "stack", "strings", "topological-sort",
	"trees", "trie", "two-pointers", "union-find",
}

// TestsRootEnv names the directory holding <slug>/tests for every problem
// (a checkout of the private problems repo).
const TestsRootEnv = "CODEJUDGE_PROBLEMS_TESTS_DIR"

// DefaultMultipliers apply to languages a problem does not list.
var DefaultMultipliers = map[string]float64{"c": 1.0, "cpp": 1.0, "go": 2.0, "python": 2.0, "java": 2.0, "javascript": 2.0} // calibrated against the seed references: docs/PHASE5_5.md, docs/PHASE5_6.md

var (
	slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	testRe = regexp.MustCompile(`^([0-9]{2,3})\.(in|out)$`)
)

// Problem is a validated problem package.
type Problem struct {
	Dir         string // the public package (problem.yaml, statement.md, samples/)
	TestsDir    string // where tests/NN.* were read from
	ID          string
	Title       string
	Difficulty  string   // easy | medium | hard
	Tags        []string // from Tags, in problem.yaml order
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

// SolutionsDir is where the reference and fixture solutions live: next to
// the tests (the private problems repo, or the package itself without a
// tests root). Only tools and tests use them; judging never does.
func (p *Problem) SolutionsDir() string { return filepath.Join(filepath.Dir(p.TestsDir), "solutions") }

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
	Difficulty     string             `yaml:"difficulty"`
	Tags           []string           `yaml:"tags"`
	TimeLimit      string             `yaml:"time_limit"`
	MemoryLimit    int64              `yaml:"memory_limit"`
	Checker        checker.Spec       `yaml:"checker"`
	TimeMultiplier map[string]float64 `yaml:"time_multiplier"`
	Samples        []string           `yaml:"samples"`
}

// Load reads and validates the problem package in dir, taking its tests from
// $CODEJUDGE_PROBLEMS_TESTS_DIR/<slug>/tests when that is set.
func Load(dir string) (*Problem, error) {
	return LoadFrom(dir, os.Getenv(TestsRootEnv))
}

// LoadFrom is Load with an explicit tests root ("" = dir/tests). With a
// tests root, the public package must not contain tests/ and must contain
// samples/ copies that are byte-identical to the hidden sample tests.
func LoadFrom(dir, testsRoot string) (*Problem, error) {
	p, err := load(dir, testsRoot)
	if err != nil {
		return nil, fmt.Errorf("problem %s: %w", filepath.Base(dir), err)
	}
	return p, nil
}

func load(dir, testsRoot string) (*Problem, error) {
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
	if !slices.Contains(Difficulties, rp.Difficulty) {
		return nil, fmt.Errorf("difficulty %q must be one of %v", rp.Difficulty, Difficulties)
	}
	if len(rp.Tags) == 0 || len(rp.Tags) > MaxTags {
		return nil, fmt.Errorf("tags: need 1..%d, got %d", MaxTags, len(rp.Tags))
	}
	for i, tag := range rp.Tags {
		if !slices.Contains(Tags, tag) {
			return nil, fmt.Errorf("tag %q is not in the vocabulary (problem.Tags)", tag)
		}
		if slices.Contains(rp.Tags[:i], tag) {
			return nil, fmt.Errorf("tag %q listed twice", tag)
		}
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

	p := &Problem{Dir: dir, TestsDir: filepath.Join(dir, "tests"), ID: rp.ID, Title: rp.Title, Difficulty: rp.Difficulty, Tags: rp.Tags, TimeLimit: tl, MemoryMB: rp.MemoryLimit, Checker: rp.Checker, Samples: rp.Samples, Multipliers: map[string]float64{}}
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

	if testsRoot != "" {
		// Split layout: hidden tests must never sit in the public package.
		if _, err := os.Stat(filepath.Join(dir, "tests")); err == nil {
			return nil, fmt.Errorf("public package has tests/ but %s is set: hidden tests belong in %s", TestsRootEnv, testsRoot)
		}
		p.TestsDir = filepath.Join(testsRoot, slug, "tests")
	}
	if err := p.loadTests(); err != nil {
		return nil, err
	}
	if err := p.checkSamples(testsRoot != ""); err != nil {
		return nil, err
	}
	return p, nil
}

// checkSamples verifies the public samples/ copies: each listed sample must
// be byte-identical to the judged test of the same name (users must see
// exactly what is judged). Required in the split layout; checked if present
// otherwise.
func (p *Problem) checkSamples(required bool) error {
	dir := filepath.Join(p.Dir, "samples")
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) && !required {
			return nil
		}
		return fmt.Errorf("samples/: %w", err)
	}
	for _, t := range p.Tests {
		if !t.Sample {
			continue
		}
		for _, pair := range [][2]string{{t.InputPath, t.Name + ".in"}, {t.OutputPath, t.Name + ".out"}} {
			judged, err := os.ReadFile(pair[0])
			if err != nil {
				return err
			}
			public, err := os.ReadFile(filepath.Join(dir, pair[1]))
			if err != nil {
				return fmt.Errorf("samples/%s: %w", pair[1], err)
			}
			if !bytes.Equal(judged, public) {
				return fmt.Errorf("samples/%s differs from the judged tests/%s", pair[1], pair[1])
			}
		}
	}
	return nil
}

func (p *Problem) loadTests() error {
	testsDir := p.TestsDir
	entries, err := os.ReadDir(testsDir)
	if os.IsNotExist(err) && os.Getenv(TestsRootEnv) == "" {
		return fmt.Errorf("%w (hidden tests live in the private problems repo: set %s to its checkout)", err, TestsRootEnv)
	}
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
