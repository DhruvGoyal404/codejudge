package problem

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContentHash(t *testing.T) {
	dir := writePkg(t, goodYAML, goodTests)
	p, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	h1, err := p.ContentHash()
	if err != nil || !strings.HasPrefix(h1, "sha256:") || len(h1) != 7+64 {
		t.Fatalf("hash %q %v", h1, err)
	}
	if h2, _ := p.ContentHash(); h2 != h1 {
		t.Fatal("hash not deterministic")
	}
	// Files outside the judged content do not change the hash.
	if err := os.MkdirAll(filepath.Join(dir, "solutions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "solutions", "ref.py"), []byte("print(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	if h, _ := p.ContentHash(); h != h1 {
		t.Fatal("solutions/ must not affect the hash")
	}
	// Changing an expected output does.
	if err := os.WriteFile(filepath.Join(dir, "tests", "03.out"), []byte("4\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if h, _ := p.ContentHash(); h == h1 {
		t.Fatal("hash did not change after editing tests/03.out")
	}
}
