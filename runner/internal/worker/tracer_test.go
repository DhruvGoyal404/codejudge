package worker

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

type trace struct {
	Steps []struct {
		L int                        `json:"l"`
		F string                     `json:"f"`
		D map[string]json.RawMessage `json:"d"`
	} `json:"steps"`
	Stdout string  `json:"stdout"`
	Capped *string `json:"capped"`
	Error  *string `json:"error"`
}

func runTraced(t *testing.T, src, stdin string) trace {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not installed")
	}
	cmd := exec.Command(py, "-I", "-c", string(traced(src)))
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("traced program failed: %v", err)
	}
	var tr trace
	if err := json.Unmarshal(out, &tr); err != nil {
		t.Fatalf("not one JSON document: %v\n%s", err, out)
	}
	return tr
}

func TestTracerRecordsLinesAndChangedLocals(t *testing.T) {
	tr := runTraced(t, "a = [3, 1, 2]\na.sort()\ns = sum(a)\nprint(s)\n", "")
	if tr.Stdout != "6\n" || tr.Error != nil || tr.Capped != nil {
		t.Fatalf("stdout %q error %v capped %v", tr.Stdout, tr.Error, tr.Capped)
	}
	var lines []int
	for _, s := range tr.Steps {
		lines = append(lines, s.L)
	}
	if fmt.Sprint(lines) != "[1 2 3 4]" {
		t.Fatalf("lines %v", lines)
	}
	if got := string(tr.Steps[2].D["a"]); got != `{"t":"list","v":[1,2,3],"n":3}` {
		t.Fatalf("a after sort = %s", got)
	}
}

func TestTracerCapsStepsAndKeepsErrors(t *testing.T) {
	if tr := runTraced(t, "i = 0\nwhile True:\n    i += 1\n", ""); tr.Capped == nil || len(tr.Steps) != 1000 {
		t.Fatalf("capped %v, %d steps", tr.Capped, len(tr.Steps))
	}
	if tr := runTraced(t, "x = []\nprint(x[1])\n", ""); tr.Error == nil || !strings.HasPrefix(*tr.Error, "IndexError") {
		t.Fatalf("error %v", tr.Error)
	}
	// A source that tries to break out of its string literal stays inert.
	if tr := runTraced(t, "s = \"\"\"\\\"\nprint('x')\n", ""); tr.Error == nil {
		t.Fatalf("expected a SyntaxError in the user's program, got %+v", tr)
	}
}
