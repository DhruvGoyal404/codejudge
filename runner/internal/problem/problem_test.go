package problem

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const goodYAML = `id: demo
title: Demo
time_limit: 1s
memory_limit: 256
checker:
  type: float
  abs_eps: 1e-6
time_multiplier:
  python: 3
samples: ["02", "01"]
`

func writePkg(t *testing.T, yaml string, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "demo")
	if err := os.MkdirAll(filepath.Join(dir, "tests"), 0o755); err != nil {
		t.Fatal(err)
	}
	all := map[string]string{"problem.yaml": yaml, "statement.md": "# Demo\n"}
	for k, v := range files {
		all[k] = v
	}
	for name, body := range all {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

var goodTests = map[string]string{
	"tests/01.in": "1\n", "tests/01.out": "1\n",
	"tests/02.in": "2\n", "tests/02.out": "2\n",
	"tests/10.in": "10\n", "tests/10.out": "10\n",
	"tests/03.in": "3\n", "tests/03.out": "3\n",
}

func TestLoadGood(t *testing.T) {
	p, err := Load(writePkg(t, goodYAML, goodTests))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tc := range p.Tests {
		n := tc.Name
		if tc.Sample {
			n += "*"
		}
		names = append(names, n)
	}
	if got := strings.Join(names, ","); got != "02*,01*,03,10" {
		t.Fatalf("test order = %s, want samples first in yaml order then sorted", got)
	}
	if p.EffectiveTimeLimit("python") != 3*time.Second || p.EffectiveTimeLimit("cpp") != time.Second {
		t.Fatalf("multipliers: py=%v cpp=%v", p.EffectiveTimeLimit("python"), p.EffectiveTimeLimit("cpp"))
	}
	if p.Checker.Type != "float" {
		t.Fatalf("checker = %+v", p.Checker)
	}
}

func TestDefaultChecker(t *testing.T) {
	p, err := Load(writePkg(t, "id: demo\ntitle: D\ntime_limit: 1s\nmemory_limit: 64\n", goodTests))
	if err != nil {
		t.Fatal(err)
	}
	if p.Checker.Type != "tokens" || p.EffectiveTimeLimit("python") != 2*time.Second {
		t.Fatalf("defaults not applied: %+v py=%v", p.Checker, p.EffectiveTimeLimit("python"))
	}
}

func TestLoadRejects(t *testing.T) {
	sub := func(old, new string) string { return strings.Replace(goodYAML, old, new, 1) }
	with := func(k, v string) map[string]string {
		m := map[string]string{}
		for a, b := range goodTests {
			m[a] = b
		}
		if v == "" {
			delete(m, k)
		} else {
			m[k] = v
		}
		return m
	}
	cases := map[string]struct {
		yaml  string
		files map[string]string
		want  string
	}{
		"missing .out":       {goodYAML, with("tests/03.out", ""), "no matching .out"},
		"orphan .out":        {goodYAML, with("tests/04.out", "4\n"), "no matching .in"},
		"stray file":         {goodYAML, with("tests/notes.txt", "x"), "unexpected entry"},
		"time too big":       {sub("time_limit: 1s", "time_limit: 6s"), goodTests, "time_limit"},
		"bad duration":       {sub("time_limit: 1s", "time_limit: fast"), goodTests, "time_limit"},
		"memory too big":     {sub("memory_limit: 256", "memory_limit: 4096"), goodTests, "memory_limit"},
		"max multiplier ok":  {sub("python: 3", "python: 5\n  cpp: 1"), goodTests, ""}, // 1s*5 = 5s: allowed
		"multiplier too big": {sub("python: 3", "python: 6"), goodTests, "time_multiplier"},
		"unknown language":   {sub("python: 3", "rust: 1"), goodTests, "unsupported language"},
		"unknown field":      {goodYAML + "memory_limt: 5\n", goodTests, "field memory_limt not found"},
		"id mismatch":        {sub("id: demo", "id: other"), goodTests, "must equal directory"},
		"bad checker":        {sub("type: float", "type: regex"), goodTests, "unknown checker"},
		"float without eps":  {sub("  abs_eps: 1e-6\n", ""), goodTests, "abs_eps"},
		"sample missing":     {sub(`["02", "01"]`, `["02", "09"]`), goodTests, "sample \"09\""},
		"sample duplicate":   {sub(`["02", "01"]`, `["02", "02"]`), goodTests, "listed twice"},
		"no tests":           {goodYAML, map[string]string{"tests/.keep": ""}, "unexpected entry"},
		"input too big":      {goodYAML, with("tests/03.in", strings.Repeat("x", MaxInputBytes+1)), "bytes >"},
		"effective over max": {sub("time_limit: 1s", "time_limit: 4s"), goodTests, "effective time limit"}, // 4s*3 = 12s > 10s
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Load(writePkg(t, c.yaml, c.files))
			if c.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want containing %q", err, c.want)
			}
		})
	}
}
