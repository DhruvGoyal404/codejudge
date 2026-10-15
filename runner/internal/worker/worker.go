// Package worker consumes judge:submissions (Valkey Streams consumer group),
// judges each submission with the Phase 2 engine and records the result.
//
// Delivery is at-least-once. Correctness comes from the database:
//   - Claim bumps submissions.attempt; every earlier attempt is fenced.
//   - FinishFenced writes only if attempt is still current.
//   - XACK only after the result commit (or when there is provably nothing
//     to do), so a crash at any point leaves the entry pending for XAUTOCLAIM.
//   - Duplicate deliveries (submission already done, or the entry is older
//     than the submission's recorded stream_entry_id) are XACKed without
//     judging, so a stray duplicate never steals a submission another worker
//     is judging.
//
// Together: at-least-once delivery + fencing = effectively-once results.
package worker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/DhruvGoyal404/codejudge/runner/internal/judge"
	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
	"github.com/DhruvGoyal404/codejudge/runner/internal/store"
)

// Config for one worker process.
type Config struct {
	WorkerID          string
	ProblemsDir       string
	SubmissionsStream string
	EventsStream      string
	Group             string
	Concurrency       int
	MaxDeliveries     int64         // after this many deliveries a submission is dead-lettered (IE)
	ClaimIdle         time.Duration // XAUTOCLAIM entries idle longer than this
	Heartbeat         time.Duration // refresh idle time of in-flight entries this often
	ReapEvery         time.Duration // periodic sandbox reaper
	RunsStream        string        // custom-input runs (runs.go)
	RunGroup          string
	RunKeyPrefix      string // Valkey hash per run: RunKeyPrefix + id (written by the API)
	RunConcurrency    int
}

// DefaultConfig returns the defaults used by judge-worker.
func DefaultConfig() Config {
	return Config{
		SubmissionsStream: "judge:submissions",
		EventsStream:      "judge:events",
		Group:             "workers",
		Concurrency:       2,
		MaxDeliveries:     3,
		ClaimIdle:         60 * time.Second,
		Heartbeat:         10 * time.Second,
		ReapEvery:         60 * time.Second,
		RunsStream:        "judge:runs",
		RunGroup:          "runners",
		RunKeyPrefix:      "judge:run:",
		RunConcurrency:    1,
	}
}

// NewWorkerID returns hostname-pid-random, unique per process.
func NewWorkerID() string {
	host, _ := os.Hostname()
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s-%d-%s", strings.ToLower(host), os.Getpid(), hex.EncodeToString(b))
}

// Worker is one judge-worker process.
type Worker struct {
	cfg Config
	db  *pgxpool.Pool
	rdb *redis.Client
	sb  *sandbox.Sandbox
	log *slog.Logger

	sem      chan struct{}
	wg       sync.WaitGroup
	mu       sync.Mutex
	inflight map[string]bool // stream entry ids being judged (heartbeated)
}

// New creates a worker. sb's containers must carry judge.instance = cfg.WorkerID
// (call sandbox.SetInstanceID before sandbox.New).
func New(cfg Config, db *pgxpool.Pool, rdb *redis.Client, sb *sandbox.Sandbox, log *slog.Logger) (*Worker, error) {
	if cfg.WorkerID == "" || cfg.ProblemsDir == "" {
		return nil, errors.New("worker id and problems dir are required")
	}
	if cfg.Concurrency <= 0 || cfg.MaxDeliveries <= 0 || cfg.ClaimIdle <= 0 || cfg.Heartbeat <= 0 || cfg.Heartbeat*2 > cfg.ClaimIdle || cfg.RunConcurrency <= 0 {
		return nil, fmt.Errorf("invalid config: need concurrency/max deliveries > 0 and 0 < 2*heartbeat <= claim idle")
	}
	return &Worker{cfg: cfg, db: db, rdb: rdb, sb: sb, log: log.With("worker", cfg.WorkerID),
		sem: make(chan struct{}, cfg.Concurrency), inflight: map[string]bool{}}, nil
}

// Run consumes until ctx is cancelled, then stops reading, waits for every
// in-flight submission to finish, and returns.
func (w *Worker) Run(ctx context.Context) error {
	err := w.rdb.XGroupCreateMkStream(ctx, w.cfg.SubmissionsStream, w.cfg.Group, "0").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return fmt.Errorf("create consumer group: %w", err)
	}
	w.log.Info("worker started", "stream", w.cfg.SubmissionsStream, "group", w.cfg.Group, "concurrency", w.cfg.Concurrency,
		"claim_idle", w.cfg.ClaimIdle, "max_deliveries", w.cfg.MaxDeliveries)

	// Background loops use their own context: they keep heartbeating
	// in-flight work during graceful shutdown and stop afterwards.
	bg, stopBg := context.WithCancel(context.Background())
	defer stopBg()
	go w.every(bg, w.cfg.Heartbeat, w.heartbeat)
	go w.every(bg, w.cfg.ReapEvery, func(c context.Context) {
		if n, err := w.sb.Reap(c); err == nil && n > 0 {
			w.log.Info("reaped stale sandbox containers", "n", n)
		}
	})

	runsDone := make(chan struct{})
	go func() { w.runLoop(ctx); close(runsDone) }()

	var lastClaim time.Time
	for ctx.Err() == nil {
		// Wait for a free slot before reading, so we never hold entries we can't run.
		select {
		case w.sem <- struct{}{}:
		case <-ctx.Done():
			continue
		}
		// Recovery runs in the same loop, with the slot already held, so it
		// can never be starved by the blocking read below.
		if time.Since(lastClaim) >= w.cfg.ClaimIdle/2 {
			lastClaim = time.Now()
			if msg, ok := w.reclaim(ctx); ok {
				w.dispatch(msg)
				continue
			}
		}
		res, err := w.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: w.cfg.Group, Consumer: w.cfg.WorkerID,
			Streams: []string{w.cfg.SubmissionsStream, ">"}, Count: 1, Block: 2 * time.Second,
		}).Result()
		if err != nil || len(res) == 0 || len(res[0].Messages) == 0 {
			<-w.sem
			if err != nil && !errors.Is(err, redis.Nil) && ctx.Err() == nil {
				w.log.Warn("XREADGROUP failed", "err", err)
				time.Sleep(time.Second)
			}
			continue
		}
		w.dispatch(res[0].Messages[0])
	}
	w.log.Info("shutting down: waiting for in-flight submissions")
	<-runsDone // no new run can be added to wg after this
	w.wg.Wait()
	w.log.Info("worker stopped")
	return nil
}

// dispatch runs one entry in the background; the caller holds a sem slot.
func (w *Worker) dispatch(msg redis.XMessage) {
	w.mu.Lock()
	w.inflight[msg.ID] = true
	w.mu.Unlock()
	w.wg.Add(1)
	go func() {
		defer func() {
			w.mu.Lock()
			delete(w.inflight, msg.ID)
			w.mu.Unlock()
			<-w.sem
			w.wg.Done()
		}()
		// In-flight work is never cancelled by shutdown: it runs to completion
		// (bounded by the sandbox's own deadlines).
		w.handle(context.Background(), msg)
	}()
}

func (w *Worker) every(ctx context.Context, d time.Duration, fn func(context.Context)) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn(ctx)
		}
	}
}

// heartbeat resets the idle time of every in-flight entry (XCLAIM JUSTID to
// ourselves does not bump the delivery counter), so a live worker's entries
// are never XAUTOCLAIMed by another worker.
func (w *Worker) heartbeat(ctx context.Context) {
	w.mu.Lock()
	ids := make([]string, 0, len(w.inflight))
	for id := range w.inflight {
		ids = append(ids, id)
	}
	w.mu.Unlock()
	if len(ids) == 0 {
		return
	}
	if err := w.rdb.XClaimJustID(ctx, &redis.XClaimArgs{Stream: w.cfg.SubmissionsStream, Group: w.cfg.Group,
		Consumer: w.cfg.WorkerID, MinIdle: 0, Messages: ids}).Err(); err != nil {
		w.log.Warn("heartbeat XCLAIM failed", "err", err)
	}
}

// reclaim XAUTOCLAIMs one entry idle longer than ClaimIdle (its worker died
// or lost it) for this worker. handle() dead-letters entries delivered more
// than MaxDeliveries. The caller holds a concurrency slot.
func (w *Worker) reclaim(ctx context.Context) (redis.XMessage, bool) {
	msgs, _, err := w.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{Stream: w.cfg.SubmissionsStream, Group: w.cfg.Group,
		Consumer: w.cfg.WorkerID, MinIdle: w.cfg.ClaimIdle, Start: "0", Count: 1}).Result()
	if err != nil || len(msgs) == 0 {
		if err != nil && ctx.Err() == nil {
			w.log.Warn("XAUTOCLAIM failed", "err", err)
		}
		return redis.XMessage{}, false
	}
	w.log.Info("reclaimed idle entry", "entry", msgs[0].ID, "submission", msgs[0].Values["id"])
	return msgs[0], true
}

// deliveries returns how many times an entry has been delivered.
func (w *Worker) deliveries(ctx context.Context, entryID string) (int64, error) {
	p, err := w.rdb.XPendingExt(ctx, &redis.XPendingExtArgs{Stream: w.cfg.SubmissionsStream, Group: w.cfg.Group,
		Start: entryID, End: entryID, Count: 1}).Result()
	if err != nil || len(p) == 0 {
		return 0, err
	}
	return p[0].RetryCount, nil
}

func (w *Worker) ack(ctx context.Context, entryID string) {
	if err := w.rdb.XAck(ctx, w.cfg.SubmissionsStream, w.cfg.Group, entryID).Err(); err != nil {
		w.log.Warn("XACK failed (entry stays pending; a later delivery will find it done)", "entry", entryID, "err", err)
	}
}

func (w *Worker) event(ctx context.Context, id, status, verdict string) {
	vals := map[string]any{"id": id, "status": status}
	if verdict != "" {
		vals["verdict"] = verdict
	}
	w.xaddEvent(ctx, id, vals)
}

// progressMinGap throttles progress events to at most 5 per second per submission.
const progressMinGap = 200 * time.Millisecond

// progressReporter returns a judge.Options.Progress callback that publishes
// {id, status: running, stage, test, total} to judge:events. Stage changes
// are always sent; within a stage, events closer than progressMinGap are
// dropped (the next one carries the newer test number).
func (w *Worker) progressReporter(ctx context.Context, id string) func(stage string, test, total int) {
	var last time.Time
	lastStage := ""
	return func(stage string, test, total int) {
		now := time.Now()
		if stage == lastStage && now.Sub(last) < progressMinGap {
			return
		}
		last, lastStage = now, stage
		w.xaddEvent(ctx, id, map[string]any{"id": id, "status": "running", "stage": stage,
			"test": strconv.Itoa(test), "total": strconv.Itoa(total)})
	}
}

func (w *Worker) xaddEvent(ctx context.Context, id string, vals map[string]any) {
	if err := w.rdb.XAdd(ctx, &redis.XAddArgs{Stream: w.cfg.EventsStream, MaxLen: 100000, Approx: true, Values: vals}).Err(); err != nil {
		w.log.Warn("XADD event failed", "submission", id, "err", err)
	}
}

// handle processes one stream entry end to end.
func (w *Worker) handle(ctx context.Context, msg redis.XMessage) {
	id, _ := msg.Values["id"].(string)
	log := w.log.With("entry", msg.ID, "submission", id)
	if id == "" {
		log.Warn("entry without id; acking")
		w.ack(ctx, msg.ID)
		return
	}

	// Duplicates first: a superseded entry must not dead-letter (or steal) a
	// submission whose current entry is still live.
	sub, err := store.LoadSubmission(ctx, w.db, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		log.Info("submission missing; acking")
		w.ack(ctx, msg.ID)
		return
	case err != nil:
		log.Error("load submission failed; leaving entry pending", "err", err)
		return
	case sub.Status == "done":
		log.Info("duplicate delivery: submission already done; acking without judging")
		w.ack(ctx, msg.ID)
		return
	case sub.StreamEntryID != "" && entryBefore(msg.ID, sub.StreamEntryID):
		// Only an entry OLDER than the recorded one is superseded. A newer one
		// may be a re-enqueue whose id is not recorded yet (XADD happens
		// before the UPDATE), so it is judged.
		log.Info("duplicate delivery: superseded stream entry; acking without judging", "current_entry", sub.StreamEntryID)
		w.ack(ctx, msg.ID)
		return
	}

	n, err := w.deliveries(ctx, msg.ID)
	if err != nil {
		log.Warn("XPENDING failed; leaving entry pending", "err", err)
		return
	}
	if n > w.cfg.MaxDeliveries {
		reason := fmt.Sprintf("dead-lettered after %d deliveries", n-1)
		if marked, err := store.DeadLetter(ctx, w.db, id, reason); err != nil {
			log.Error("dead-letter failed; leaving entry pending", "err", err)
			return
		} else if marked {
			w.event(ctx, id, "done", judge.IE)
		}
		log.Warn("dead-lettered", "deliveries", n)
		w.ack(ctx, msg.ID)
		return
	}

	attempt, ok, err := store.Claim(ctx, w.db, id, w.cfg.WorkerID)
	if err != nil {
		log.Error("claim failed; leaving entry pending", "err", err)
		return
	}
	if !ok {
		log.Info("already done; acking")
		w.ack(ctx, msg.ID)
		return
	}
	log = log.With("attempt", attempt)
	log.Info("judging", "problem", sub.ProblemSlug, "lang", sub.Language, "deliveries", n)
	w.event(ctx, id, "running", "")

	final := w.judge(ctx, sub, log, w.progressReporter(ctx, id))

	written, err := store.FinishFenced(ctx, w.db, id, attempt, final)
	switch {
	case err != nil:
		log.Error("recording result failed; leaving entry pending", "err", err)
		return
	case !written:
		// A newer attempt exists (we were presumed dead and reclaimed). Do NOT
		// XACK: the entry now belongs to the newer attempt's delivery.
		log.Warn("stale attempt: result discarded by fencing")
		return
	}
	w.ack(ctx, msg.ID) // only after the commit
	w.event(ctx, id, "done", final.Verdict)
	if final.Verdict == judge.IE {
		log.Warn("done with internal error", "failed_test", final.FailedTest, "reason", truncate(final.Reason, 500))
	} else {
		log.Info("done", "verdict", final.Verdict, "failed_test", final.FailedTest)
	}
}

// judge runs the Phase 2 engine. Any judge-side failure becomes IE.
func (w *Worker) judge(ctx context.Context, sub *store.Submission, log *slog.Logger, progress func(string, int, int)) store.Final {
	ie := func(reason string) store.Final {
		log.Error("internal error", "reason", reason)
		return store.Final{Verdict: judge.IE, Reason: reason}
	}
	l, err := lang.Get(sub.Language)
	if err != nil {
		return ie(err.Error())
	}
	p, err := problem.Load(filepath.Join(w.cfg.ProblemsDir, sub.ProblemSlug))
	if err != nil {
		return ie("load problem: " + err.Error())
	}
	hash, err := p.ContentHash()
	if err != nil {
		return ie("hash problem: " + err.Error())
	}
	if hash != sub.ContentHash {
		return ie(fmt.Sprintf("problem package on disk (%s) does not match the database (%s); re-run judge-admin import", hash[:19], sub.ContentHash[:min(19, len(sub.ContentHash))]))
	}
	res, err := judge.Judge(ctx, w.sb, p, l, []byte(sub.Source), judge.Options{Progress: progress})
	if err != nil {
		return ie("judge: " + err.Error())
	}
	f := store.Final{Verdict: res.Verdict, Reason: res.Reason, FailedTest: res.FailedTest, FailedIsSample: res.FailedIsSample,
		MaxCPUMs: res.MaxCPUMs, MaxRSSKB: res.MaxRSSKB}
	if res.Verdict == judge.CE && res.CompileOutput != "" {
		f.Reason = truncate(res.CompileOutput, 4096)
	}
	for _, t := range res.Tests {
		row := store.TestRow{Seq: t.Index, Name: t.Name, IsSample: t.Sample, Status: t.Verdict, CPUMs: t.CPUMs, RSSKB: t.MaxRSSKB}
		if t.Sample { // hidden-test output is never stored
			out := t.Stdout
			row.Stdout, row.StdoutTruncated = &out, t.StdoutTruncated
		}
		f.Tests = append(f.Tests, row)
	}
	return f
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "...[truncated]"
	}
	return s
}

// entryBefore reports whether stream entry id a ("ms-seq") is strictly older
// than b. Unparseable ids compare as not-before (the entry is judged).
func entryBefore(a, b string) bool {
	am, as, ok1 := parseEntryID(a)
	bm, bs, ok2 := parseEntryID(b)
	if !ok1 || !ok2 {
		return false
	}
	return am < bm || (am == bm && as < bs)
}

func parseEntryID(id string) (ms, seq uint64, ok bool) {
	m, s, found := strings.Cut(id, "-")
	if !found {
		return 0, 0, false
	}
	ms, err1 := strconv.ParseUint(m, 10, 64)
	seq, err2 := strconv.ParseUint(s, 10, 64)
	return ms, seq, err1 == nil && err2 == nil
}
