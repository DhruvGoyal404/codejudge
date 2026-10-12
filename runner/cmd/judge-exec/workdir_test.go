package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResetWorkDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "box")
	outside := filepath.Join(root, "outside.txt")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(dir, "a", "b"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "input"), []byte("1 2\n"), 0o400))
	must(os.WriteFile(filepath.Join(dir, "a", "b", "f"), []byte("x"), 0o644))
	must(os.WriteFile(filepath.Join(dir, ".hidden"), []byte("x"), 0o644))
	must(os.WriteFile(outside, []byte("keep"), 0o644))
	if runtime.GOOS != "windows" {
		must(os.Symlink(outside, filepath.Join(dir, "link")))
		must(os.Chmod(filepath.Join(dir, "a"), 0o000)) // program locked a dir
	}

	must(resetWorkDir(dir))

	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Fatalf("entries left: %v", left)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("work dir itself removed: %v", err)
	}
	if b, err := os.ReadFile(outside); err != nil || string(b) != "keep" {
		t.Fatalf("file outside work dir affected: %q %v", b, err)
	}
	must(resetWorkDir(dir)) // idempotent on an empty dir
}
