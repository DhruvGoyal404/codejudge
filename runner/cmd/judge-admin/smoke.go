package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DhruvGoyal404/codejudge/runner/internal/store"
)

// smokeCmd is the post-deploy end-to-end check: it inserts one submission
// (no user), queues it on the submissions stream exactly as the API would,
// waits for a live worker to judge it, and requires AC. The row is deleted
// afterwards whatever the outcome. It exercises Postgres, Valkey, the worker,
// the sandbox images and the hidden tests together.
func smokeCmd(args []string) error {
	fs := flag.NewFlagSet("smoke", flag.ContinueOnError)
	slug := fs.String("problem", "ledger-total", "problem slug")
	language := fs.String("lang", "cpp", "language")
	srcPath := fs.String("src", "", "source file (a reference solution)")
	timeout := fs.Duration("timeout", 5*time.Minute, "how long to wait for the verdict")
	stream := fs.String("stream", envOr("JUDGE_SUBMISSIONS_STREAM", "judge:submissions"), "submissions stream")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *srcPath == "" {
		return errors.New("--src is required")
	}
	src, err := os.ReadFile(*srcPath)
	if err != nil {
		return err
	}
	dbURL, err := store.DatabaseURL()
	if err != nil {
		return err
	}
	vk := os.Getenv("CODEJUDGE_VALKEY_URL")
	if vk == "" {
		return errors.New("CODEJUDGE_VALKEY_URL is not set")
	}
	opt, err := redis.ParseURL(vk)
	if err != nil {
		return fmt.Errorf("CODEJUDGE_VALKEY_URL: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout+30*time.Second)
	defer cancel()
	pool, err := store.Connect(ctx, dbURL, 2)
	if err != nil {
		return err
	}
	defer pool.Close()
	rdb := redis.NewClient(opt)
	defer rdb.Close()

	var id string
	err = pool.QueryRow(ctx, `INSERT INTO submissions (problem_id, language, source, status)
		SELECT id, $2, $3, 'queued' FROM problems WHERE slug = $1 RETURNING id`, *slug, *language, string(src)).Scan(&id)
	if err != nil {
		return fmt.Errorf("insert smoke submission (is %q imported?): %w", *slug, err)
	}
	defer func() {
		// Background context: clean up even after a timeout.
		_, _ = pool.Exec(context.Background(), `DELETE FROM submissions WHERE id = $1`, id)
	}()
	entry, err := rdb.XAdd(ctx, &redis.XAddArgs{Stream: *stream, Values: map[string]any{"id": id}}).Result()
	if err != nil {
		return fmt.Errorf("enqueue: %w", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE submissions SET enqueued_at = now(), stream_entry_id = $2 WHERE id = $1`, id, entry); err != nil {
		return err
	}
	fmt.Printf("smoke: submission %s queued (%s %s)\n", id, *slug, *language)

	deadline := time.Now().Add(*timeout)
	for time.Now().Before(deadline) {
		var status string
		var verdict, reason *string
		if err := pool.QueryRow(ctx, `SELECT status, verdict, reason FROM submissions WHERE id = $1`, id).Scan(&status, &verdict, &reason); err != nil {
			return err
		}
		if status == "done" {
			v, r := deref(verdict), deref(reason)
			fmt.Printf("smoke: verdict %s %s\n", v, r)
			if v != "AC" {
				return fmt.Errorf("verdict %s, want AC", v)
			}
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("no verdict within %v (is judge-worker running?)", *timeout)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
