package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Submission is what a worker needs to judge one submission.
type Submission struct {
	ID          string
	Status      string
	Language    string
	Source      string
	ProblemSlug string
	ContentHash string
	// StreamEntryID is the judge:submissions entry of the current enqueue
	// (empty if not recorded yet). Any other entry for this submission is a
	// duplicate delivery.
	StreamEntryID string
}

// ErrNotFound is returned when a submission does not exist.
var ErrNotFound = errors.New("submission not found")

// LoadSubmission reads a submission with its problem's slug and content hash.
func LoadSubmission(ctx context.Context, pool *pgxpool.Pool, id string) (*Submission, error) {
	var s Submission
	err := pool.QueryRow(ctx, `
		SELECT s.id::text, s.status, s.language, s.source, p.slug, p.content_hash, coalesce(s.stream_entry_id, '')
		  FROM submissions s JOIN problems p ON p.id = s.problem_id
		 WHERE s.id = $1`, id).Scan(&s.ID, &s.Status, &s.Language, &s.Source, &s.ProblemSlug, &s.ContentHash, &s.StreamEntryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &s, err
}

// Claim marks a submission running for workerID and bumps its attempt
// counter, which fences every earlier attempt. ok=false when the submission
// is already done (or gone): nothing to do.
func Claim(ctx context.Context, pool *pgxpool.Pool, id, workerID string) (attempt int, ok bool, err error) {
	err = pool.QueryRow(ctx, `
		UPDATE submissions
		   SET status = 'running', attempt = attempt + 1, worker_id = $2, started_at = now()
		 WHERE id = $1 AND status IN ('queued', 'running')
		RETURNING attempt`, id, workerID).Scan(&attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	return attempt, err == nil, err
}

// TestRow is one submission_tests row.
type TestRow struct {
	Seq      int
	Name     string
	IsSample bool
	Status   string
	CPUMs    int64
	RSSKB    int64
	// Stdout is stored for sample tests only (the DB rejects it otherwise).
	Stdout          *string
	StdoutTruncated bool
}

// Final is a submission's outcome.
type Final struct {
	Verdict        string
	Reason         string
	FailedTest     string
	FailedIsSample bool
	MaxCPUMs       int64
	MaxRSSKB       int64
	Tests          []TestRow
}

// FinishFenced records the outcome only if attempt is still the current
// attempt and the submission is running: a stale worker (whose attempt was
// superseded by a reclaim) gets written=false and its result is discarded.
// The verdict row and its submission_tests rows commit atomically.
func FinishFenced(ctx context.Context, pool *pgxpool.Pool, id string, attempt int, f Final) (written bool, err error) {
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE submissions
			   SET status = 'done', verdict = $3::text, reason = NULLIF($4::text, ''),
			       failed_test = NULLIF($5::text, ''),
			       failed_is_sample = CASE WHEN $5::text = '' THEN NULL ELSE $6::boolean END,
			       max_cpu_ms = $7::integer, max_rss_kb = $8::integer, finished_at = now()
			 WHERE id = $1::uuid AND attempt = $2::integer AND status = 'running'`,
			id, attempt, f.Verdict, f.Reason, f.FailedTest, f.FailedIsSample, f.MaxCPUMs, f.MaxRSSKB)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil // fenced out: leave written=false, commit nothing
		}
		written = true
		if _, err := tx.Exec(ctx, `DELETE FROM submission_tests WHERE submission_id = $1`, id); err != nil {
			return err
		}
		for _, t := range f.Tests {
			if _, err := tx.Exec(ctx, `
				INSERT INTO submission_tests (submission_id, seq, name, is_sample, status, cpu_ms, rss_kb, stdout, stdout_truncated)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				id, t.Seq, t.Name, t.IsSample, t.Status, t.CPUMs, t.RSSKB, t.Stdout, t.StdoutTruncated); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		written = false
	}
	return written, err
}

// DeadLetter marks a submission IE after too many deliveries. No-op if done.
func DeadLetter(ctx context.Context, pool *pgxpool.Pool, id, reason string) (bool, error) {
	tag, err := pool.Exec(ctx, `
		UPDATE submissions
		   SET status = 'done', verdict = 'IE', reason = $2, finished_at = now()
		 WHERE id = $1 AND status <> 'done'`, id, reason)
	return tag.RowsAffected() == 1, err
}
