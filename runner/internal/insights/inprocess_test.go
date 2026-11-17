package insights

import (
	"strings"
	"testing"
	"time"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
)

func TestHarnessSourceJava(t *testing.T) {
	java, _ := lang.Get("java")
	src := "import java.util.*;\npublic class Main {\n  public static void main(String[] a) { Main.go(); }\n  static void go() {}\n}\n"
	out, ok := harnessSource(java, src)
	if !ok {
		t.Fatal("plain Main should be wrapped")
	}
	if !strings.HasPrefix(out, "import java.util.*;\nclass UserMain {") || !strings.Contains(out, "UserMain.go();") {
		t.Fatalf("user class not renamed:\n%s", out[:120])
	}
	if strings.Count(out, "public class Main") != 1 || !strings.Contains(out, "UserMain.main(new String[0])") {
		t.Fatal("harness is not the public Main")
	}
	for _, bad := range []string{"class Solution {}", "public class Main { void f() { System.exit(0); } }"} {
		if _, ok := harnessSource(java, bad); ok {
			t.Errorf("should fall back: %q", bad)
		}
	}
}

func TestHarnessSourceJS(t *testing.T) {
	js, _ := lang.Get("javascript")
	out, ok := harnessSource(js, "const d = require(\"fs\").readFileSync(0, \"utf8\");\nconsole.log(d.length);\n")
	if !ok || !strings.HasPrefix(out, "const USER_SOURCE = \"const d = require(\\\"fs\\\")") {
		t.Fatalf("not wrapped: %q", out[:80])
	}
	if _, ok := harnessSource(js, "process.stdin.on(\"data\", d => {});"); ok {
		t.Error("async stdin should fall back")
	}
	if py, _ := lang.Get("python"); true {
		if _, ok := harnessSource(py, "print(1)"); ok {
			t.Error("python has no harness")
		}
	}
}

func TestHarnessInputFramesAndCaps(t *testing.T) {
	in, n := harnessInput([][]byte{[]byte("1\n5\n"), []byte("2\n5 6\n")}, 1500*time.Millisecond, 3)
	if n != 2 || string(in) != "2\n1500000000\n3\n4\n1\n5\n6\n2\n5 6\n" {
		t.Fatalf("framing: %d %q", n, in)
	}
	big := make([]byte, 8<<20)
	if _, n := harnessInput([][]byte{big, big, big}, time.Second, 3); n != 1 {
		t.Fatalf("stdin cap: kept %d of 3 8 MiB inputs", n)
	}
}
