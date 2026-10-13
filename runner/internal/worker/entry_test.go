package worker

import "testing"

func TestEntryBefore(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1-1", "1791891537583-0", true},
		{"1791891537583-0", "1-1", false}, // newer than recorded: judge it
		{"5-0", "5-1", true},
		{"5-1", "5-1", false},
		{"10-0", "9-99", false}, // numeric, not lexicographic
		{"9-99", "10-0", true},
		{"junk", "5-0", false},
		{"5-0", "", false},
	}
	for _, c := range cases {
		if got := entryBefore(c.a, c.b); got != c.want {
			t.Errorf("entryBefore(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
