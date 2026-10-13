// Typed client for the Express API (same-origin via the /api proxy).

export type Language = "cpp" | "python";
export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "cpp", label: "C++17" },
  { id: "python", label: "Python 3.12" },
];
export const MAX_SOURCE_BYTES = 64 * 1024;

export type Verdict = "AC" | "WA" | "CE" | "RE" | "TLE" | "MLE" | "OLE" | "IE";
export type Status = "queued" | "running" | "done";

export interface ProblemSummary {
  slug: string;
  title: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  /** For the logged-in user: some AC / submissions but no AC / none (or logged out). */
  my_status: "solved" | "attempted" | null;
}

export interface User {
  id: number;
  github_id: number;
  login: string;
  avatar_url: string | null;
}

export interface Sample {
  name: string;
  input: string;
  output: string;
}

export interface Problem extends ProblemSummary {
  statement_md: string;
  checker: { type: string; abs_eps?: number; rel_eps?: number };
  samples: Sample[];
}

export interface TestResult {
  seq: number;
  name: string;
  is_sample: boolean;
  status: Exclude<Verdict, "CE">;
  cpu_ms: number;
  rss_kb: number;
  stdout?: string | null; // samples only
  stdout_truncated?: boolean | null; // samples only
}

export interface Submission {
  id: string;
  problem_slug: string;
  language: Language;
  status: Status;
  verdict: Verdict | null;
  reason: string | null;
  failed_test: string | null;
  failed_is_sample: boolean | null;
  max_cpu_ms: number | null;
  max_rss_kb: number | null;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  tests: TestResult[];
  /** True when the logged-in user owns it; only then is `source` present. */
  mine: boolean;
  source?: string;
}

/** HTTP error from the API (has a status code and the server's message). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    /** Seconds, from Retry-After on 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** The API could not be reached at all (server down, network). */
export class NetworkError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new NetworkError("Cannot reach the judge API. Is it running?");
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new NetworkError("The judge API is unavailable right now.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const ra = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`, body?.details, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  return body as T;
}

/** Where "Log in with GitHub" goes; the API returns the browser to `next` afterwards. */
export function loginUrl(next: string): string {
  return `/api/auth/github?next=${encodeURIComponent(next)}`;
}

export const api = {
  /** The logged-in user, or null when logged out. */
  me: () =>
    request<User>("/me").catch((err) => {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }),
  /** 204 has no body; request() resolves it to null. */
  logout: () => request<null>("/auth/logout", { method: "POST" }),
  problems: () => request<{ problems: ProblemSummary[] }>("/problems").then((r) => r.problems),
  problem: (slug: string) => request<Problem>(`/problems/${encodeURIComponent(slug)}`),
  submission: (id: string) => request<Submission>(`/submissions/${encodeURIComponent(id)}`),
  submit: (problemSlug: string, language: Language, source: string) =>
    request<{ id: string }>("/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problemSlug, language, source }),
    }),
};

/** Human-readable message for a submit failure (413 / 400 / 422 / network). */
export function submitErrorMessage(err: unknown): string {
  if (err instanceof NetworkError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 413) return "Your code is too large (the limit is 64 KB).";
    if (err.status === 400 || err.status === 422) {
      const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
      const first = fields ? Object.entries(fields).find(([, v]) => v?.length) : undefined;
      return first ? `Invalid submission: ${first[0]} — ${first[1][0]}` : `Invalid submission: ${err.message}`;
    }
    if (err.status === 404) return "This problem no longer exists.";
    if (err.status === 401) return "You are logged out. Log in to submit.";
    if (err.status === 409) return "You already have 2 submissions being judged. Wait for one to finish.";
    if (err.status === 429) {
      return err.retryAfter ? `Too many submissions. Try again in ${formatWait(err.retryAfter)}.` : "Too many submissions. Try again later.";
    }
    return `Submission failed: ${err.message}`;
  }
  return "Submission failed unexpectedly.";
}

function formatWait(s: number): string {
  if (s < 90) return `${s} s`;
  if (s < 2 * 3600) return `${Math.ceil(s / 60)} min`;
  return `${Math.ceil(s / 3600)} h`;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  AC: "Accepted",
  WA: "Wrong Answer",
  CE: "Compilation Error",
  RE: "Runtime Error",
  TLE: "Time Limit Exceeded",
  MLE: "Memory Limit Exceeded",
  OLE: "Output Limit Exceeded",
  IE: "Internal Error",
};
