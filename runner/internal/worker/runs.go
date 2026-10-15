package worker

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
	"github.com/DhruvGoyal404/codejudge/runner/internal/problem"
	"github.com/DhruvGoyal404/codejudge/runner/internal/sandbox"
)

// "Run with custom input" (Phase 5.5 U). A run executes the user's program
// once on the user's own input, under the problem's limits, and returns its
// output. Runs are ephemeral and at-most-once: the API stores the job in a
// Valkey hash (RunKeyPrefix+id, with a TTL) and XADDs its id to RunsStream;
// the worker acks the entry as soon as it reads it, executes, and writes the
// result into the same hash. A run lost to a crash simply never finishes and
// the browser reports a timeout. Nothing is stored in Postgres and no hidden
// test is involved.

// RunOutputBytes caps a run's stdout (more is OLE).
const RunOutputBytes = 64 << 10

// RunResult is what the API returns for a finished run.
type RunResult struct {
	Status          string `json:"status"` // OK, CE, RE, TLE, MLE, OLE, IE
	Reason          string `json:"reason,omitempty"`
	ExitCode        int    `json:"exit_code"`
	CPUMs           int64  `json:"cpu_ms"`
	WallMs          int64  `json:"wall_ms"`
	MaxRSSKB        int64  `json:"max_rss_kb"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdout_truncated"`
	CompileOutput   string `json:"compile_output,omitempty"`
}

func (w *Worker) runLoop(ctx context.Context) {
	err := w.rdb.XGroupCreateMkStream(ctx, w.cfg.RunsStream, w.cfg.RunGroup, "$").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		w.log.Error("create runs consumer group failed; custom runs disabled", "err", err)
		return
	}
	sem := make(chan struct{}, w.cfg.RunConcurrency)
	for ctx.Err() == nil {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			continue
		}
		res, err := w.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: w.cfg.RunGroup, Consumer: w.cfg.WorkerID,
			Streams: []string{w.cfg.RunsStream, ">"}, Count: 1, Block: 2 * time.Second,
		}).Result()
		if err != nil || len(res) == 0 || len(res[0].Messages) == 0 {
			<-sem
			if err != nil && !errors.Is(err, redis.Nil) && ctx.Err() == nil {
				w.log.Warn("XREADGROUP (runs) failed", "err", err)
				time.Sleep(time.Second)
			}
			continue
		}
		msg := res[0].Messages[0]
		// At most once: ack before running.
		if err := w.rdb.XAck(ctx, w.cfg.RunsStream, w.cfg.RunGroup, msg.ID).Err(); err != nil {
			w.log.Warn("XACK (runs) failed", "err", err)
		}
		id, _ := msg.Values["id"].(string)
		w.wg.Add(1)
		go func() {
			defer func() { <-sem; w.wg.Done() }()
			w.handleRun(context.Background(), id)
		}()
	}
}

func (w *Worker) handleRun(ctx context.Context, id string) {
	log := w.log.With("run", id)
	key := w.cfg.RunKeyPrefix + id
	job, err := w.rdb.HGetAll(ctx, key).Result()
	if err != nil || job["status"] != "queued" {
		log.Info("run missing, expired or already taken", "err", err)
		return
	}
	if err := w.rdb.HSet(ctx, key, "status", "running").Err(); err != nil {
		log.Warn("mark run running failed", "err", err)
		return
	}
	result := w.execRun(ctx, job, log)
	body, _ := json.Marshal(result)
	if err := w.rdb.HSet(ctx, key, "status", "done", "result", string(body)).Err(); err != nil {
		log.Error("store run result failed", "err", err)
		return
	}
	log.Info("run done", "status", result.Status, "cpu_ms", result.CPUMs)
}

func (w *Worker) execRun(ctx context.Context, job map[string]string, log interface{ Error(string, ...any) }) RunResult {
	ie := func(reason string) RunResult {
		log.Error("run internal error", "reason", reason)
		return RunResult{Status: sandbox.StatusIE, Reason: reason}
	}
	l, err := lang.Get(job["language"])
	if err != nil {
		return ie(err.Error())
	}
	p, err := problem.Load(filepath.Join(w.cfg.ProblemsDir, job["slug"]))
	if err != nil {
		return ie("load problem: " + err.Error())
	}
	lim := sandbox.Limits{TimeLimit: p.EffectiveTimeLimit(l.Name), MemoryMB: p.MemoryMB, OutputBytes: RunOutputBytes}
	res, err := w.sb.Execute(ctx, l, []byte(job["source"]), []byte(job["input"]), lim)
	if err != nil {
		return ie("execute: " + err.Error())
	}
	out := RunResult{Status: res.Status, Reason: res.Reason, ExitCode: res.ExitCode, CPUMs: res.CPUMs, WallMs: res.WallMs,
		MaxRSSKB: res.MaxRSSKB, Stdout: res.Stdout, Stderr: truncate(res.Stderr, 8192), StdoutTruncated: res.StdoutTruncated}
	if res.Status == sandbox.StatusCE {
		out.CompileOutput = truncate(res.CompileOutput, 8192)
		if out.CompileOutput == "" {
			out.CompileOutput = truncate(res.Stderr, 8192)
		}
	}
	return out
}
