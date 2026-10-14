package problem

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSplit writes the same problem as writePkg(goodYAML, goodTests), but in
// the split layout: public dir (yaml, statement, samples/) + tests root.
func writeSplit(t *testing.T) (publicDir, testsRoot string) {
	t.Helper()
	base := t.TempDir()
	publicDir = filepath.Join(base, "public", "demo")
	testsRoot = filepath.Join(base, "private")
	files := map[string]string{
		filepath.Join(publicDir, "problem.yaml"): goodYAML,
		filepath.Join(publicDir, "statement.md"): "# Demo\n",
	}
	for name, body := range goodTests {
		files[filepath.Join(testsRoot, "demo", name)] = body
	}
	for _, s := range []string{"01", "02"} { // the samples listed in goodYAML
		files[filepath.Join(publicDir, "samples", s+".in")] = goodTests["tests/"+s+".in"]
		files[filepath.Join(publicDir, "samples", s+".out")] = goodTests["tests/"+s+".out"]
	}
	for path, body := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return publicDir, testsRoot
}

func TestSplitLayoutLoadsWithTheSameHash(t *testing.T) {
	single, err := Load(writePkg(t, goodYAML, goodTests))
	if err != nil {
		t.Fatal(err)
	}
	pub, root := writeSplit(t)
	split, err := LoadFrom(pub, root)
	if err != nil {
		t.Fatal(err)
	}
	if split.TestsDir != filepath.Join(root, "demo", "tests") {
		t.Fatalf("TestsDir = %s", split.TestsDir)
	}
	if len(split.Tests) != len(single.Tests) || !split.Tests[0].Sample || split.Tests[0].Name != "02" {
		t.Fatalf("tests = %+v", split.Tests)
	}
	h1, _ := single.ContentHash()
	h2, err := split.ContentHash()
	if err != nil || h1 != h2 {
		t.Fatalf("hash differs between layouts: %s vs %s (%v)", h1, h2, err)
	}

	// Load picks the tests root up from the environment.
	t.Setenv(TestsRootEnv, root)
	viaEnv, err := Load(pub)
	if err != nil || viaEnv.TestsDir != split.TestsDir {
		t.Fatalf("Load via %s: %v %v", TestsRootEnv, viaEnv, err)
	}
}

func TestSplitLayoutRejects(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(pub, root string) error
		want   string
	}{
		{"sample input differs", func(pub, _ string) error {
			return os.WriteFile(filepath.Join(pub, "samples", "01.in"), []byte("999\n"), 0o644)
		}, "samples/01.in differs"},
		{"sample output differs", func(pub, _ string) error {
			return os.WriteFile(filepath.Join(pub, "samples", "02.out"), []byte("2 \n"), 0o644)
		}, "samples/02.out differs"},
		{"sample missing", func(pub, _ string) error { return os.Remove(filepath.Join(pub, "samples", "02.out")) }, "samples/02.out"},
		{"no samples dir", func(pub, _ string) error { return os.RemoveAll(filepath.Join(pub, "samples")) }, "samples/"},
		{"hidden tests left in the public package", func(pub, _ string) error {
			return os.MkdirAll(filepath.Join(pub, "tests"), 0o755)
		}, "public package has tests/"},
		{"no tests in the tests root", func(_, root string) error { return os.RemoveAll(filepath.Join(root, "demo")) }, "tests"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pub, root := writeSplit(t)
			if err := c.mutate(pub, root); err != nil {
				t.Fatal(err)
			}
			_, err := LoadFrom(pub, root)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to mention %q", err, c.want)
			}
		})
	}
}

func TestSingleDirSamplesCheckedWhenPresent(t *testing.T) {
	files := map[string]string{}
	for k, v := range goodTests {
		files[k] = v
	}
	dir := writePkg(t, goodYAML, files)
	if err := os.MkdirAll(filepath.Join(dir, "samples"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"01.in", "01.out", "02.in", "02.out"} {
		if err := os.WriteFile(filepath.Join(dir, "samples", f), []byte(goodTests["tests/"+f]), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Load(dir); err != nil {
		t.Fatalf("matching samples rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "samples", "01.out"), []byte("nope\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "samples/01.out differs") {
		t.Fatalf("err = %v", err)
	}
}
