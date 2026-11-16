package worker

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DhruvGoyal404/codejudge/runner/internal/insights"
	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/store"
)

// Insights (docs/INSIGHTS.md): the API inserts a queued row into insights and
// XADDs its id to InsightsStream. Like custom runs, analyses are at most once:
// the entry is acked on read; a crash leaves the row running, and the API
// lets the owner retry one that has been running too long. Analyses yield to
// judging: before every program run the worker waits while any submission is
// in flight or waiting in the judge stream.

const (
	yieldPoll = 250 * time.Millisecond
)

var errBusy = errors.New("the judge stayed busy; try again later")

func (w *Worker) insightsLoop(ctx context.Context) {
	err := w.rdb.XGroupCreateMkStream(ctx, w.cfg.InsightsStream, w.cfg.InsightsGroup, "$").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		w.log.Error("create insights consumer group failed; insights disabled", "err", err)
		return
	}
	for ctx.Err() == nil {
		res, err := w.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: w.cfg.InsightsGroup, Consumer: w.cfg.WorkerID,
			Streams: []string{w.cfg.InsightsStream, ">"}, Count: 1, Block: 2 * time.Second,
		}).Result()
		if err != nil || len(res) == 0 || len(res[0].Messages) == 0 {
			if err != nil && !errors.Is(err, redis.Nil) && ctx.Err() == nil {
				w.log.Warn("XREADGROUP (insights) failed", "err", err)
				time.Sleep(time.Second)
			}
			continue
		}
		msg := res[0].Messages[0]
		if err := w.rdb.XAck(ctx, w.cfg.InsightsStream, w.cfg.InsightsGroup, msg.ID).Err(); err != nil {
			w.log.Warn("XACK (insights) failed", "err", err)
		}
		id, err := strconv.ParseInt(fmt.Sprint(msg.Values["id"]), 10, 64)
		if err != nil {
			w.log.Warn("bad insights entry", "entry", msg.ID)
			continue
		}
		// One at a time, in this goroutine: analyses are the lowest priority.
		w.wg.Add(1)
		w.handleInsight(context.Background(), id)
		w.wg.Done()
	}
}

func (w *Worker) handleInsight(ctx context.Context, id int64) {
	log := w.log.With("insight", id)
	job, ok, err := store.ClaimInsight(ctx, w.db, id)
	if err != nil || !ok {
		log.Info("insight missing or already taken", "err", err)
		return
	}
	start := time.Now()
	log.Info("insight started", "problem", job.Slug, "lang", job.Language)
	rep, err := w.analyze(ctx, job)
	if err != nil {
		log.Warn("insight failed", "err", err)
		if err := store.FailInsight(ctx, w.db, id, err.Error()); err != nil {
			log.Error("store insight failure failed", "err", err)
		}
		return
	}
	if err := store.FinishInsight(ctx, w.db, id, rep); err != nil {
		log.Error("store insight report failed", "err", err)
		return
	}
	log.Info("insight done", "class", rep.Time.Class, "cpu_ms", rep.CPUSpentMs, "ms", time.Since(start).Milliseconds())
}

func (w *Worker) analyze(ctx context.Context, job store.InsightJob) (*insights.Report, error) {
	l, err := lang.Get(job.Language)
	if err != nil {
		return nil, err
	}
	p, err := problem.Load(filepath.Join(w.cfg.ProblemsDir, job.Slug))
	if err != nil {
		return nil, fmt.Errorf("load problem: %w", err)
	}
	lad, err := insights.LoadLadder(p)
	if err != nil {
		return nil, fmt.Errorf("load ladder: %w", err)
	}
	if h, err := lad.Hash(); err != nil || h != job.LadderHash {
		return nil, fmt.Errorf("ladder on disk does not match the imported one (err %v)", err)
	}
	ctx, cancel := context.WithTimeout(ctx, w.cfg.InsightsMaxWait)
	defer cancel()
	return insights.Analyze(ctx, w.sb, p, lad, l, []byte(job.Source), insights.Options{Yield: w.yieldToJudging})
}

// yieldToJudging blocks while judging has work (in flight here, or waiting in
// the submissions stream), up to the analysis deadline. On the first busy
// check it calls release, so the paused analysis holds no container.
func (w *Worker) yieldToJudging(ctx context.Context, release func()) error {
	var start time.Time
	for w.judgingBusy(ctx) {
		if start.IsZero() {
			start = time.Now()
			if release != nil {
				release()
			}
		}
		select {
		case <-ctx.Done():
			return errBusy
		case <-time.After(yieldPoll):
		}
	}
	if !start.IsZero() {
		w.log.Info("insight resumed after judging", "paused_ms", time.Since(start).Milliseconds())
	}
	return nil
}

func (w *Worker) judgingBusy(ctx context.Context) bool {
	w.mu.Lock()
	n := len(w.inflight)
	w.mu.Unlock()
	if n > 0 {
		return true
	}
	groups, err := w.rdb.XInfoGroups(ctx, w.cfg.SubmissionsStream).Result()
	if err != nil {
		return false // can't tell: don't stall analyses on a Valkey hiccup
	}
	for _, g := range groups {
		if g.Name == w.cfg.Group && (g.Lag > 0 || g.Pending > 0) {
			return true
		}
	}
	return false
}
