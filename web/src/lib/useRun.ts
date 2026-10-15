import { useCallback, useEffect, useRef, useState } from "react";

import { api, runErrorMessage, type Language, type RunResult } from "../api.ts";

export type RunPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; id: string; status: "queued" | "running" }
  | { phase: "done"; id: string; result: RunResult; input: string }
  | { phase: "error"; message: string };

const POLL_MS = 600;
const GIVE_UP_MS = 90_000;

/**
 * "Run with custom input": POST /runs, then poll GET /runs/:id until the
 * result is there. A run that never finishes (worker restarted) ends in an
 * error after GIVE_UP_MS.
 */
export function useRun() {
  const [state, setState] = useState<RunPhase>({ phase: "idle" });
  const token = useRef(0); // a newer run (or unmount) cancels the old poller

  useEffect(() => () => void token.current++, []);

  const start = useCallback(async (slug: string, language: Language, source: string, input: string) => {
    const mine = ++token.current;
    setState({ phase: "starting" });
    let id: string;
    try {
      id = (await api.run(slug, language, source, input)).id;
    } catch (err) {
      if (mine === token.current) setState({ phase: "error", message: runErrorMessage(err) });
      return;
    }
    const deadline = Date.now() + GIVE_UP_MS;
    setState({ phase: "waiting", id, status: "queued" });
    while (mine === token.current) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (mine !== token.current) return;
      try {
        const r = await api.getRun(id);
        if (mine !== token.current) return;
        if (r.status === "done" && r.result) {
          setState({ phase: "done", id, result: r.result, input });
          return;
        }
        setState({ phase: "waiting", id, status: r.status === "running" ? "running" : "queued" });
      } catch {
        // Transient failure: keep polling until the deadline.
      }
      if (Date.now() > deadline) {
        setState({ phase: "error", message: "The run did not finish in time. Please try again." });
        return;
      }
    }
  }, []);

  return { state, start, busy: state.phase === "starting" || state.phase === "waiting" };
}
