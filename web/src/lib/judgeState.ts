// Result-panel state machine (pure; unit-tested):
//
//   idle --SUBMIT--> submitting --SUBMITTED--> queued --STATUS(running)--> running(stage)
//   running --PROGRESS--> running(compiling | testing k/n)
//   any live state --VERDICT--> done
//   submitting --SUBMIT_FAILED--> error
//   live states --CONNECTION_LOST--> same state, reconnecting=true
//   --RESYNC(submission)--> state derived from the authoritative submission
import type { Submission } from "../api.ts";

export type Stage = { stage: "compiling" | "testing"; test: number; total: number };

export type JudgeState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; message: string }
  | { phase: "queued"; id: string; reconnecting: boolean }
  | { phase: "running"; id: string; progress: Stage | null; reconnecting: boolean }
  | { phase: "done"; id: string; submission: Submission };

export type JudgeEvent =
  | { type: "SUBMIT" }
  | { type: "SUBMITTED"; id: string }
  | { type: "SUBMIT_FAILED"; message: string }
  | { type: "STATUS"; id: string; status: "queued" | "running" | "done" }
  | { type: "PROGRESS"; id: string; stage: Stage["stage"]; test: number; total: number }
  | { type: "VERDICT"; submission: Submission }
  | { type: "CONNECTION_LOST"; id: string }
  | { type: "RESYNC"; submission: Submission }
  | { type: "SHOW"; id: string } // open an older submission
  | { type: "RESET" };

const activeId = (s: JudgeState) => ("id" in s ? s.id : null);

export function judgeReducer(state: JudgeState, ev: JudgeEvent): JudgeState {
  switch (ev.type) {
    case "SUBMIT":
      return state.phase === "submitting" ? state : { phase: "submitting" };
    case "SUBMITTED":
      return { phase: "queued", id: ev.id, reconnecting: false };
    case "SUBMIT_FAILED":
      return { phase: "error", message: ev.message };
    case "SHOW":
      return { phase: "queued", id: ev.id, reconnecting: false };
    case "RESET":
      return { phase: "idle" };
  }

  // Everything below concerns the active submission; ignore stale events.
  const id = "id" in ev ? ev.id : ev.submission.id;
  if (id !== activeId(state) || state.phase === "done") {
    // A verdict for the active id always wins, even over "done" (re-sync).
    if (ev.type === "RESYNC" && id === activeId(state)) return fromSubmission(ev.submission);
    return state;
  }

  switch (ev.type) {
    case "STATUS":
      if (ev.status === "running") {
        return state.phase === "running" ? { ...state, reconnecting: false } : { phase: "running", id, progress: null, reconnecting: false };
      }
      if (ev.status === "queued") return { phase: "queued", id, reconnecting: false };
      return state; // "done" carries no data; the VERDICT event follows
    case "PROGRESS": {
      const progress: Stage = { stage: ev.stage, test: ev.test, total: ev.total };
      if (state.phase === "running" && state.progress && isOlder(progress, state.progress)) return state;
      return { phase: "running", id, progress, reconnecting: false };
    }
    case "VERDICT":
      return { phase: "done", id, submission: ev.submission };
    case "CONNECTION_LOST":
      return state.phase === "queued" || state.phase === "running" ? { ...state, reconnecting: true } : state;
    case "RESYNC":
      return fromSubmission(ev.submission, state);
  }
}

/** Progress never moves backwards (events can arrive out of order across reconnects). */
function isOlder(next: Stage, cur: Stage): boolean {
  if (cur.stage === "testing" && next.stage === "compiling") return true;
  return next.stage === cur.stage && next.test < cur.test;
}

function fromSubmission(s: Submission, prev?: JudgeState): JudgeState {
  if (s.status === "done") return { phase: "done", id: s.id, submission: s };
  if (s.status === "running") {
    const progress = prev?.phase === "running" ? prev.progress : null;
    return { phase: "running", id: s.id, progress, reconnecting: false };
  }
  return { phase: "queued", id: s.id, reconnecting: false };
}

/** One-line description of where judging is, for the UI and tests. */
export function stageLabel(state: JudgeState): string {
  switch (state.phase) {
    case "idle":
      return "Not submitted yet";
    case "submitting":
      return "Submitting…";
    case "error":
      return state.message;
    case "queued":
      return "Queued";
    case "running":
      if (!state.progress) return "Running";
      return state.progress.stage === "compiling" ? "Compiling" : `Running test ${state.progress.test} of ${state.progress.total}`;
    case "done":
      return state.submission.verdict ?? "Done";
  }
}
