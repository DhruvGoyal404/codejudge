// Package checker compares a program's output with the expected output.
// Checkers run on the host only: expected output never enters a container.
package checker

import (
	"bytes"
	"fmt"
	"math"
	"strconv"
)

// Checker types.
const (
	Exact  = "exact"  // byte-equal after CRLF->LF and trailing-newline normalization
	Tokens = "tokens" // whitespace-separated tokens equal (default)
	Float  = "float"  // tokens; numeric tokens within abs/rel epsilon
)

// Spec selects and configures a checker (problem.yaml "checker:").
type Spec struct {
	Type   string  `yaml:"type"`
	AbsEps float64 `yaml:"abs_eps"`
	RelEps float64 `yaml:"rel_eps"`
}

// Result of a comparison. Message explains a mismatch; it never contains more
// than a short excerpt of either output.
type Result struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

// Validate checks a Spec, applying the default type.
func (s *Spec) Validate() error {
	if s.Type == "" {
		s.Type = Tokens
	}
	switch s.Type {
	case Exact, Tokens:
		if s.AbsEps != 0 || s.RelEps != 0 {
			return fmt.Errorf("checker %q does not take abs_eps/rel_eps", s.Type)
		}
	case Float:
		if s.AbsEps < 0 || s.RelEps < 0 || s.AbsEps > 1 || s.RelEps > 1 || math.IsNaN(s.AbsEps) || math.IsNaN(s.RelEps) {
			return fmt.Errorf("float checker: abs_eps and rel_eps must be in [0, 1]")
		}
		if s.AbsEps == 0 && s.RelEps == 0 {
			return fmt.Errorf("float checker: set abs_eps and/or rel_eps")
		}
	default:
		return fmt.Errorf("unknown checker %q (exact | tokens | float)", s.Type)
	}
	return nil
}

// Check compares got (program output) with want (expected output).
func Check(s Spec, got, want []byte) Result {
	switch s.Type {
	case Exact:
		return checkExact(got, want)
	case Float:
		return checkTokens(got, want, func(g, w []byte) (bool, string) { return floatEq(g, w, s.AbsEps, s.RelEps) })
	default:
		return checkTokens(got, want, func(g, w []byte) (bool, string) { return bytes.Equal(g, w), "" })
	}
}

func normalize(b []byte) []byte {
	b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
	return bytes.TrimRight(b, "\n")
}

func checkExact(got, want []byte) Result {
	g, w := normalize(got), normalize(want)
	if bytes.Equal(g, w) {
		return Result{OK: true}
	}
	// Locate first differing line for the message.
	line := 1
	n := min(len(g), len(w))
	i := 0
	for ; i < n && g[i] == w[i]; i++ {
		if g[i] == '\n' {
			line++
		}
	}
	return Result{Message: fmt.Sprintf("line %d differs: expected %s, got %s", line, excerptLine(w, i), excerptLine(g, i))}
}

func excerptLine(b []byte, at int) string {
	start := bytes.LastIndexByte(b[:at], '\n') + 1
	end := len(b)
	if j := bytes.IndexByte(b[at:], '\n'); j >= 0 {
		end = at + j
	}
	if at >= len(b) && start >= len(b) {
		return "<end of output>"
	}
	return quote(b[start:end])
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}

// tokenizer walks whitespace-separated tokens without allocating.
type tokenizer struct {
	b   []byte
	pos int
}

func (t *tokenizer) next() ([]byte, bool) {
	for t.pos < len(t.b) && isSpace(t.b[t.pos]) {
		t.pos++
	}
	if t.pos >= len(t.b) {
		return nil, false
	}
	start := t.pos
	for t.pos < len(t.b) && !isSpace(t.b[t.pos]) {
		t.pos++
	}
	return t.b[start:t.pos], true
}

func checkTokens(got, want []byte, eq func(g, w []byte) (bool, string)) Result {
	gt, wt := tokenizer{b: got}, tokenizer{b: want}
	for i := 1; ; i++ {
		g, gok := gt.next()
		w, wok := wt.next()
		switch {
		case !gok && !wok:
			return Result{OK: true}
		case !gok:
			return Result{Message: fmt.Sprintf("output ended early: token %d expected %s", i, quote(w))}
		case !wok:
			return Result{Message: fmt.Sprintf("extra output: token %d is %s", i, quote(g))}
		}
		if ok, why := eq(g, w); !ok {
			msg := fmt.Sprintf("token %d: expected %s, got %s", i, quote(w), quote(g))
			if why != "" {
				msg += " (" + why + ")"
			}
			return Result{Message: msg}
		}
	}
}

// parseNum accepts anything strconv.ParseFloat accepts, including values that
// overflow to ±Inf (ErrRange).
func parseNum(b []byte) (float64, bool) {
	v, err := strconv.ParseFloat(string(b), 64)
	if err == nil {
		return v, true
	}
	if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
		return v, true
	}
	return 0, false
}

func floatEq(g, w []byte, absEps, relEps float64) (bool, string) {
	wv, wnum := parseNum(w)
	if !wnum {
		return bytes.Equal(g, w), ""
	}
	gv, gnum := parseNum(g)
	if !gnum {
		return false, "not a number"
	}
	switch {
	case math.IsNaN(wv):
		return math.IsNaN(gv), ""
	case math.IsNaN(gv):
		return false, "NaN"
	case math.IsInf(wv, 0) || math.IsInf(gv, 0):
		return wv == gv, ""
	}
	diff := math.Abs(gv - wv)
	if diff <= absEps || diff <= relEps*math.Abs(wv) {
		return true, ""
	}
	return false, fmt.Sprintf("|diff| = %g", diff)
}

func quote(b []byte) string {
	const max = 48
	if len(b) > max {
		return strconv.Quote(string(b[:max])) + "..."
	}
	return strconv.Quote(string(b))
}
