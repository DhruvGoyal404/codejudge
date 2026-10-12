package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// resetWorkDir removes every entry under dir and keeps dir itself. Entries the
// program made unwritable (e.g. chmod 000 directories) are made removable
// first; symlinks are removed, never followed. Returns an error if anything is
// left behind, so a caller can fail closed rather than reuse a dirty dir.
func resetWorkDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		makeRemovable(p)
		if err := os.RemoveAll(p); err != nil {
			return err
		}
	}
	left, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(left) != 0 {
		return fmt.Errorf("reset %s: %d entries left (first %q)", dir, len(left), left[0].Name())
	}
	return nil
}

// makeRemovable grants the owner rwx on p and every directory below it.
// Lstat: symlinks are not followed, so nothing outside dir is touched.
func makeRemovable(p string) {
	fi, err := os.Lstat(p)
	if err != nil || !fi.IsDir() {
		return
	}
	_ = os.Chmod(p, 0o700)
	entries, err := os.ReadDir(p)
	if err != nil {
		return
	}
	for _, e := range entries {
		makeRemovable(filepath.Join(p, e.Name()))
	}
}
