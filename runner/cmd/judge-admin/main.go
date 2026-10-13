// Command judge-admin manages problem metadata in Postgres.
//
//	judge-admin import problems/            # validate every package, upsert metadata + content_hash + samples
//	judge-admin import problems/ledger-total
//
// Database: $CODEJUDGE_DATABASE_URL.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/store"
)

func main() {
	if len(os.Args) != 3 || os.Args[1] != "import" {
		fmt.Fprintln(os.Stderr, "usage: judge-admin import <problems-dir | problem-dir>")
		os.Exit(2)
	}
	if err := importCmd(os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "judge-admin:", err)
		os.Exit(1)
	}
}

func importCmd(path string) error {
	dirs, err := packageDirs(path)
	if err != nil {
		return err
	}
	// Validate everything first: a bad package aborts the import before any write.
	var probs []*problem.Problem
	for _, d := range dirs {
		p, err := problem.Load(d)
		if err != nil {
			return err
		}
		probs = append(probs, p)
	}
	url, err := store.DatabaseURL()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := store.Connect(ctx, url, 2)
	if err != nil {
		return err
	}
	defer pool.Close()
	for _, p := range probs {
		res, err := store.UpsertProblem(ctx, pool, p)
		if err != nil {
			return fmt.Errorf("%s: %w", p.ID, err)
		}
		state := "unchanged"
		if res.Changed {
			state = "updated"
		}
		fmt.Printf("%-18s %s %s (%d tests, %d samples)\n", res.Slug, state, res.Hash[:19], len(p.Tests), len(p.Samples))
	}
	return nil
}

// packageDirs returns path itself if it is a package, else its package subdirs.
func packageDirs(path string) ([]string, error) {
	if _, err := os.Stat(filepath.Join(path, "problem.yaml")); err == nil {
		return []string{path}, nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			if _, err := os.Stat(filepath.Join(path, e.Name(), "problem.yaml")); err == nil {
				dirs = append(dirs, filepath.Join(path, e.Name()))
			}
		}
	}
	sort.Strings(dirs)
	if len(dirs) == 0 {
		return nil, fmt.Errorf("no problem packages under %s", path)
	}
	return dirs, nil
}
