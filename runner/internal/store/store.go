// Package store holds the Postgres access shared by judge-admin and
// judge-worker. All SQL is parameterized.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
)

// DatabaseURL returns $CODEJUDGE_DATABASE_URL (required).
func DatabaseURL() (string, error) {
	u := os.Getenv("CODEJUDGE_DATABASE_URL")
	if u == "" {
		return "", fmt.Errorf("CODEJUDGE_DATABASE_URL is not set (e.g. postgres://codejudge:<pw>@127.0.0.1:55432/codejudge?sslmode=disable)")
	}
	return u, nil
}

// Connect opens a small pool (the dev machine is memory-constrained).
func Connect(ctx context.Context, url string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = maxConns
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// ImportResult reports what UpsertProblem did.
type ImportResult struct {
	Slug    string
	Hash    string
	Changed bool // inserted, or content_hash differed
}

// UpsertProblem writes a validated package's metadata, content hash and
// public samples. Hidden tests are never stored: they stay on disk for the
// worker only.
func UpsertProblem(ctx context.Context, pool *pgxpool.Pool, p *problem.Problem) (ImportResult, error) {
	hash, err := p.ContentHash()
	if err != nil {
		return ImportResult{}, err
	}
	checker, err := json.Marshal(map[string]any{"type": p.Checker.Type, "abs_eps": p.Checker.AbsEps, "rel_eps": p.Checker.RelEps})
	if err != nil {
		return ImportResult{}, err
	}
	res := ImportResult{Slug: p.ID, Hash: hash}
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var old *string
		if err := tx.QueryRow(ctx, `SELECT content_hash FROM problems WHERE slug = $1 FOR UPDATE`, p.ID).Scan(&old); err != nil && err != pgx.ErrNoRows {
			return err
		}
		res.Changed = old == nil || *old != hash
		var id int64
		err := tx.QueryRow(ctx, `
			INSERT INTO problems (slug, title, statement_md, time_limit_ms, memory_limit_mb, checker, content_hash)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (slug) DO UPDATE SET
				title = EXCLUDED.title, statement_md = EXCLUDED.statement_md,
				time_limit_ms = EXCLUDED.time_limit_ms, memory_limit_mb = EXCLUDED.memory_limit_mb,
				checker = EXCLUDED.checker, content_hash = EXCLUDED.content_hash,
				updated_at = CASE WHEN problems.content_hash = EXCLUDED.content_hash THEN problems.updated_at ELSE now() END
			RETURNING id`,
			p.ID, p.Title, p.Statement, p.TimeLimit.Milliseconds(), p.MemoryMB, checker, hash).Scan(&id)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM problem_samples WHERE problem_id = $1`, id); err != nil {
			return err
		}
		seq := 0
		for _, t := range p.Tests {
			if !t.Sample {
				continue // hidden tests never leave the disk
			}
			in, err := t.Input()
			if err != nil {
				return err
			}
			out, err := t.Expected()
			if err != nil {
				return err
			}
			seq++
			if _, err := tx.Exec(ctx, `INSERT INTO problem_samples (problem_id, seq, name, input, output) VALUES ($1, $2, $3, $4, $5)`,
				id, seq, t.Name, string(in), string(out)); err != nil {
				return err
			}
		}
		return nil
	})
	return res, err
}
