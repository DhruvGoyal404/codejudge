package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// InsightJob is a claimed analysis: what to run and on which ladder.
type InsightJob struct {
	ID         int64
	Slug       string
	Language   string
	LadderHash string
	Source     string
}

// ClaimInsight moves a queued analysis to running and returns it; ok is false
// if it is gone or already taken (at most once: the stream entry is acked
// before this).
func ClaimInsight(ctx context.Context, pool *pgxpool.Pool, id int64) (InsightJob, bool, error) {
	j := InsightJob{ID: id}
	err := pool.QueryRow(ctx, `
		UPDATE insights i SET status = 'running', started_at = now()
		FROM problems p, submissions s
		WHERE i.id = $1 AND i.status = 'queued' AND p.id = i.problem_id AND s.id = i.submission_id
		RETURNING p.slug, i.language, i.ladder_hash, s.source`, id).Scan(&j.Slug, &j.Language, &j.LadderHash, &j.Source)
	if err == pgx.ErrNoRows {
		return j, false, nil
	}
	return j, err == nil, err
}

// FinishInsight stores a report (fenced: only a running analysis).
func FinishInsight(ctx context.Context, pool *pgxpool.Pool, id int64, report any) error {
	b, err := json.Marshal(report)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `UPDATE insights SET status = 'done', report = $2, finished_at = now() WHERE id = $1 AND status = 'running'`, id, b)
	return err
}

// FailInsight records why an analysis could not run. The API lets the owner
// retry a failed one.
func FailInsight(ctx context.Context, pool *pgxpool.Pool, id int64, reason string) error {
	_, err := pool.Exec(ctx, `UPDATE insights SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'`, id, reason)
	return err
}
