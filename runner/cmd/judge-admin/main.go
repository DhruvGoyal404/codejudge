// Command judge-admin manages problem metadata in Postgres.
//
//	judge-admin import problems/            # validate every package, upsert metadata + content_hash + samples
//	judge-admin import problems/ledger-total
//	judge-admin check problems/             # validate only (no database): bounds, tests, public samples
//	                                        # byte-identical to the hidden ones; prints content hashes;
//	                                        # catalog rules (catalogCheck)
//
// Database: $CODEJUDGE_DATABASE_URL. Hidden tests: $CODEJUDGE_PROBLEMS_TESTS_DIR
// (the private problems repo; unset = <package>/tests).
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
	if len(os.Args) != 3 || (os.Args[1] != "import" && os.Args[1] != "check") {
		fmt.Fprintln(os.Stderr, "usage: judge-admin import|check <problems-dir | problem-dir>")
		os.Exit(2)
	}
	cmd := importCmd
	if os.Args[1] == "check" {
		cmd = checkCmd
	}
	if err := cmd(os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "judge-admin:", err)
		os.Exit(1)
	}
}

// loadAll validates every package under path; the first bad one is an error.
func loadAll(path string) ([]*problem.Problem, error) {
	dirs, err := packageDirs(path)
	if err != nil {
		return nil, err
	}
	var probs []*problem.Problem
	for _, d := range dirs {
		p, err := problem.Load(d)
		if err != nil {
			return nil, err
		}
		probs = append(probs, p)
	}
	return probs, nil
}

func checkCmd(path string) error {
	probs, err := loadAll(path)
	if err != nil {
		return err
	}
	for _, p := range probs {
		h, err := p.ContentHash()
		if err != nil {
			return fmt.Errorf("%s: %w", p.ID, err)
		}
		if err := catalogCheck(p); err != nil {
			return fmt.Errorf("%s: %w", p.ID, err)
		}
		fmt.Printf("%-18s ok %s (%d tests, %d samples) tests from %s\n", p.ID, h[:19], len(p.Tests), len(p.Samples), p.TestsDir)
	}
	return nil
}

func importCmd(path string) error {
	// Validate everything first: a bad package aborts the import before any write.
	probs, err := loadAll(path)
	if err != nil {
		return err
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

// catalogCheck applies the rules for a published problem on top of what Load
// validates: enough tests and, when the private repo is available, the files
// that produced and cross-check them (scripts/make-tests.py).
func catalogCheck(p *problem.Problem) error {
	if len(p.Tests) < problem.CatalogMinTests {
		return fmt.Errorf("%d tests, a published problem needs at least %d", len(p.Tests), problem.CatalogMinTests)
	}
	root := os.Getenv(problem.TestsRootEnv)
	if root == "" {
		return nil
	}
	priv := filepath.Join(root, p.ID)
	for _, f := range []string{"gen/gen.py", "gen/validate.py", "solutions/ref.cpp", "solutions/ref.py"} {
		if _, err := os.Stat(filepath.Join(priv, f)); err != nil {
			return fmt.Errorf("private repo: %w", err)
		}
	}
	if p.Difficulty != "easy" {
		slow, err := filepath.Glob(filepath.Join(priv, "solutions", "slow.*"))
		if err != nil {
			return err
		}
		if len(slow) == 0 {
			return fmt.Errorf("private repo: a %s problem needs a solutions/slow.* that must TLE", p.Difficulty)
		}
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
