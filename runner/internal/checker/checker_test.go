package checker

import (
	"bytes"
	"strings"
	"testing"
)

type tc struct {
	name      string
	got, want string
	ok        bool
}

func run(t *testing.T, s Spec, cases []tc) {
	t.Helper()
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := Check(s, []byte(c.got), []byte(c.want))
			if r.OK != c.ok {
				t.Fatalf("Check(%q, %q) = %+v, want ok=%v", c.got, c.want, r, c.ok)
			}
			if !r.OK && r.Message == "" {
				t.Fatal("mismatch without message")
			}
		})
	}
}

func TestExact(t *testing.T) {
	run(t, Spec{Type: Exact}, []tc{
		{"equal", "1 2\n3\n", "1 2\n3\n", true},
		{"crlf", "1 2\r\n3\r\n", "1 2\n3\n", true},
		{"missing trailing newline", "1 2\n3", "1 2\n3\n", true},
		{"extra trailing newlines", "1 2\n3\n\n\n", "1 2\n3\n", true},
		{"both empty", "", "", true},
		{"empty vs newline", "", "\n", true},
		{"empty output", "", "42\n", false},
		{"extra spaces matter", "1  2\n3\n", "1 2\n3\n", false},
		{"trailing space matters", "1 2 \n3\n", "1 2\n3\n", false},
		{"leading newline matters", "\n1 2\n3\n", "1 2\n3\n", false},
		{"extra line", "1 2\n3\n4\n", "1 2\n3\n", false},
		{"lone CR not normalized", "1\r2\n", "1\n2\n", false},
	})
}

func TestTokens(t *testing.T) {
	run(t, Spec{}, []tc{ // default type
		{"equal", "1 2 3\n", "1 2 3\n", true},
		{"whitespace insensitive", "  1\t2\r\n\n3   ", "1 2 3\n", true},
		{"both empty", "", "", true},
		{"only whitespace vs empty", " \n\t", "", true},
		{"empty output", "", "42\n", false},
		{"extra trailing token", "1 2 3 4\n", "1 2 3\n", false},
		{"missing token", "1 2\n", "1 2 3\n", false},
		{"different token", "1 2 4\n", "1 2 3\n", false},
		{"numbers compared as text", "1.0\n", "1\n", false},
		{"case sensitive", "YES\n", "yes\n", false},
		{"nan text", "nan\n", "NaN\n", false},
	})
}

func TestFloat(t *testing.T) {
	run(t, Spec{Type: Float, AbsEps: 1e-6, RelEps: 1e-6}, []tc{
		{"exact", "3.141593\n", "3.141593\n", true},
		{"within abs", "0.0000005\n", "0\n", true},
		{"outside abs small", "0.00001\n", "0\n", false},
		{"within rel large", "1000000000.5\n", "1000000000\n", true},
		{"outside rel large", "1000002000\n", "1000000000\n", false},
		{"int vs float form", "2\n", "2.000000\n", true},
		{"exponent form", "1.5e2\n", "150\n", true},
		{"non-numeric exact", "YES 1.0000001\n", "YES 1\n", true},
		{"non-numeric mismatch", "NO 1\n", "YES 1\n", false},
		{"word where number expected", "abc\n", "1\n", false},
		{"nan expected nan", "nan\n", "NaN\n", true},
		{"nan vs number", "nan\n", "1\n", false},
		{"number vs nan", "1\n", "nan\n", false},
		{"inf equal", "inf\n", "Infinity\n", true},
		{"inf sign", "-inf\n", "inf\n", false},
		{"inf vs large finite", "1e308\n", "inf\n", false},
		{"overflow parses as inf", "1e400\n", "inf\n", true},
		{"negative zero", "-0.0\n", "0\n", true},
		{"extra trailing token", "1 2\n", "1\n", false},
		{"empty output", "", "1\n", false},
		{"both empty", "", "", true},
	})
}

func TestFloatValidate(t *testing.T) {
	for _, s := range []Spec{{Type: Float}, {Type: Float, AbsEps: -1}, {Type: Float, RelEps: 2}, {Type: "regex"}, {Type: Exact, AbsEps: 1e-6}} {
		if err := s.Validate(); err == nil {
			t.Errorf("Validate(%+v) accepted invalid spec", s)
		}
	}
}

func TestHugeOutputs(t *testing.T) {
	const n = 1_000_000
	var want bytes.Buffer
	for i := 0; i < n; i++ {
		want.WriteString("123456789 ")
	}
	got := []byte(strings.ReplaceAll(want.String(), " ", "\n"))
	for _, typ := range []string{Tokens, Float} {
		s := Spec{Type: typ}
		if typ == Float {
			s.AbsEps = 1e-9
		}
		if r := Check(s, got, want.Bytes()); !r.OK {
			t.Fatalf("%s: %+v", typ, r)
		}
		bad := append(append([]byte{}, got...), []byte("extra")...)
		if r := Check(s, bad, want.Bytes()); r.OK || len(r.Message) > 200 {
			t.Fatalf("%s: want short mismatch message, got %+v", typ, r)
		}
	}
	// A single 10 MB token must not break the tokenizer (no 64 KB scanner limit).
	big := bytes.Repeat([]byte("x"), 10<<20)
	if r := Check(Spec{Type: Tokens}, big, big); !r.OK {
		t.Fatalf("huge single token: %+v", r)
	}
	if r := Check(Spec{Type: Exact}, big[:len(big)-1], big); r.OK || len(r.Message) > 300 {
		t.Fatalf("exact huge mismatch: %+v", r)
	}
}
