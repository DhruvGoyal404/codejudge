import { useEffect } from "react";

import { api, type Submission } from "../api.ts";
import type { JudgeEvent } from "./judgeState.ts";

/**
 * Follows one submission over SSE (/api/submissions/:id/events) and feeds the
 * result-panel reducer. The server sends the current state first, every
 * change, then the verdict and closes. On a dropped connection EventSource
 * reconnects by itself; when it does, we also re-fetch the submission so the
 * panel resynchronises even if events were missed.
 */
export function useSubmissionStream(id: string | null, dispatch: (e: JudgeEvent) => void) {
  useEffect(() => {
    if (!id) return;
    let finished = false;
    let dropped = false;
    const cleanupTimers: ReturnType<typeof setInterval>[] = [];
    const es = new EventSource(`/api/submissions/${encodeURIComponent(id)}/events`);

    const resync = () =>
      api
        .submission(id)
        .then((s) => dispatch({ type: "RESYNC", submission: s }))
        .catch(() => {});

    es.addEventListener("open", () => {
      if (dropped) {
        dropped = false;
        void resync();
      }
    });
    es.addEventListener("status", (m) => {
      const d = JSON.parse((m as MessageEvent).data) as { status: "queued" | "running" | "done" };
      dispatch({ type: "STATUS", id, status: d.status });
    });
    es.addEventListener("progress", (m) => {
      const d = JSON.parse((m as MessageEvent).data) as { stage: "compiling" | "testing"; test: number; total: number };
      dispatch({ type: "PROGRESS", id, stage: d.stage, test: d.test, total: d.total });
    });
    es.addEventListener("verdict", (m) => {
      finished = true;
      dispatch({ type: "VERDICT", submission: JSON.parse((m as MessageEvent).data) as Submission });
      es.close(); // the server closes the stream after the verdict; don't reconnect
    });
    es.addEventListener("error", () => {
      if (finished) return;
      dropped = true;
      dispatch({ type: "CONNECTION_LOST", id });
      // EventSource retries automatically while readyState is CONNECTING.
      // If it gave up (CLOSED), fall back to polling the REST endpoint.
      if (es.readyState === EventSource.CLOSED) {
        const timer = setInterval(async () => {
          try {
            const s = await api.submission(id);
            dispatch({ type: "RESYNC", submission: s });
            if (s.status === "done") clearInterval(timer);
          } catch {
            /* still down; keep trying */
          }
        }, 3000);
        cleanupTimers.push(timer);
      }
    });

    return () => {
      finished = true;
      es.close();
      cleanupTimers.forEach(clearInterval);
    };
  }, [id, dispatch]);
}
