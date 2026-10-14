// Command judge-worker consumes judge:submissions and judges submissions.
//
// Environment:
//
//	CODEJUDGE_DATABASE_URL   postgres://...                 (required)
//	CODEJUDGE_VALKEY_URL     redis://127.0.0.1:56379        (required)
//	CODEJUDGE_PROBLEMS_DIR   problems/                      (default: find repo problems/)
//	CODEJUDGE_PROBLEMS_TESTS_DIR  checkout of the private problems repo (hidden
//	                         tests: <dir>/<slug>/tests); unset = problems/<slug>/tests
//	JUDGE_WORKER_ID          unique id (default hostname-pid-random)
//	JUDGE_CONCURRENCY        2
//	JUDGE_MAX_DELIVERIES     3
//	JUDGE_CLAIM_IDLE         60s   XAUTOCLAIM threshold (in-flight entries are heartbeated)
//	JUDGE_HEARTBEAT          10s
//	JUDGE_SUBMISSIONS_STREAM judge:submissions
//	JUDGE_EVENTS_STREAM      judge:events
//	JUDGE_RUNTIME            OCI runtime for sandbox containers: runsc (gVisor) in
//	                         production; empty = engine default (runc, dev)
//
// SIGINT/SIGTERM: stop reading, finish in-flight submissions, exit. A second
// signal exits immediately.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
	"github.com/DhruvGoyal404/codejudge/runner/internal/store"
	"github.com/DhruvGoyal404/codejudge/runner/internal/worker"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("judge-worker failed", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg := worker.DefaultConfig()
	cfg.WorkerID = envOr("JUDGE_WORKER_ID", worker.NewWorkerID())
	cfg.SubmissionsStream = envOr("JUDGE_SUBMISSIONS_STREAM", cfg.SubmissionsStream)
	cfg.EventsStream = envOr("JUDGE_EVENTS_STREAM", cfg.EventsStream)
	var err error
	if cfg.Concurrency, err = envInt("JUDGE_CONCURRENCY", cfg.Concurrency); err != nil {
		return err
	}
	md, err := envInt("JUDGE_MAX_DELIVERIES", int(cfg.MaxDeliveries))
	if err != nil {
		return err
	}
	cfg.MaxDeliveries = int64(md)
	if cfg.ClaimIdle, err = envDur("JUDGE_CLAIM_IDLE", cfg.ClaimIdle); err != nil {
		return err
	}
	if cfg.Heartbeat, err = envDur("JUDGE_HEARTBEAT", cfg.Heartbeat); err != nil {
		return err
	}
	cfg.ProblemsDir = os.Getenv("CODEJUDGE_PROBLEMS_DIR")
	if cfg.ProblemsDir == "" {
		y, err := sandbox.FindRepoFile("problems/ledger-total/problem.yaml")
		if err != nil {
			return fmt.Errorf("CODEJUDGE_PROBLEMS_DIR not set and problems/ not found: %w", err)
		}
		cfg.ProblemsDir = filepath.Dir(filepath.Dir(y))
	}

	dbURL, err := store.DatabaseURL()
	if err != nil {
		return err
	}
	vkURL := os.Getenv("CODEJUDGE_VALKEY_URL")
	if vkURL == "" {
		return fmt.Errorf("CODEJUDGE_VALKEY_URL is not set (e.g. redis://127.0.0.1:56379)")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { // second signal: exit now
		<-ctx.Done()
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		<-ch
		log.Warn("second signal: exiting immediately")
		os.Exit(130)
	}()

	pool, err := store.Connect(context.Background(), dbURL, int32(cfg.Concurrency+2))
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	defer pool.Close()
	opt, err := redis.ParseURL(vkURL)
	if err != nil {
		return err
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		return fmt.Errorf("valkey: %w", err)
	}

	seccomp, err := sandbox.FindRepoFile("sandbox/seccomp/default.json")
	if err != nil {
		return err
	}
	lock, err := sandbox.FindRepoFile("sandbox/images/images.lock.json")
	if err != nil {
		return err
	}
	sandbox.SetInstanceID(cfg.WorkerID) // containers carry judge.instance = worker id
	sb, err := sandbox.New(context.Background(), sandbox.Options{SeccompPath: seccomp, ImagesLockPath: lock, Concurrency: cfg.Concurrency, Runtime: os.Getenv("JUDGE_RUNTIME")})
	if err != nil {
		return err
	}
	defer sb.Close()

	w, err := worker.New(cfg, pool, rdb, sb, log)
	if err != nil {
		return err
	}
	return w.Run(ctx)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) (int, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", k, err)
	}
	return n, nil
}

func envDur(k string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", k, err)
	}
	return d, nil
}
