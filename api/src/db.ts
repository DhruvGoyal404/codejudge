import pg from "pg";

export interface SessionUser {
  id: number;
  github_id: number;
  login: string;
  avatar_url: string | null;
}

/** All SQL here is parameterized; no string interpolation of values. */
export class Db {
  constructor(readonly pool: pg.Pool) {}

  static connect(url: string, max: number): Db {
    return new Db(new pg.Pool({ connectionString: url, max }));
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  /**
   * Problem list; for a logged-in user each row also carries my_status
   * ('solved' = some AC, 'attempted' = submissions but no AC, else null).
   * One query (LEFT JOIN + GROUP BY); userId null = anonymous.
   */
  async listProblems(userId: number | null) {
    const r = await this.pool.query(
      `SELECT p.slug, p.title, p.difficulty, p.tags, p.time_limit_ms, p.memory_limit_mb,
              CASE WHEN bool_or(s.verdict = 'AC') THEN 'solved'
                   WHEN count(s.id) > 0 THEN 'attempted' END AS my_status
         FROM problems p
         LEFT JOIN submissions s ON s.problem_id = p.id AND s.user_id = $1
        GROUP BY p.id
        ORDER BY p.slug`,
      [userId],
    );
    return r.rows;
  }

  /**
   * A user's submissions, newest first, keyset-paginated on (created_at, id).
   * `after` is the (created_at as Postgres text, id) of the last row of the
   * previous page; text keeps microsecond precision (a JS Date would not).
   * Returns limit+1 rows at most so the caller can tell if there is more.
   */
  async listUserSubmissions(
    userId: number,
    f: { problem?: string; verdict?: string; after?: { t: string; id: string }; limit: number },
  ) {
    const r = await this.pool.query(
      `SELECT s.id, p.slug AS problem_slug, p.title AS problem_title, s.language, s.status, s.verdict,
              s.max_cpu_ms, s.max_rss_kb, s.created_at, s.finished_at, s.created_at::text AS cursor_t
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = $1
          AND ($2::text IS NULL OR p.slug = $2)
          AND ($3::text IS NULL OR s.verdict = $3)
          AND ($4::timestamptz IS NULL OR (s.created_at, s.id) < ($4::timestamptz, $5::uuid))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $6`,
      [userId, f.problem ?? null, f.verdict ?? null, f.after?.t ?? null, f.after?.id ?? null, f.limit + 1],
    );
    return r.rows as ({ id: string; cursor_t: string } & Record<string, unknown>)[];
  }

  /** The source of a submission, only if userId owns it (else null). */
  async getOwnSource(id: string, userId: number): Promise<string | null> {
    const r = await this.pool.query(`SELECT source FROM submissions WHERE id = $1 AND user_id = $2`, [id, userId]);
    return r.rows[0]?.source ?? null;
  }

  /** Statement + public samples only. Hidden tests are not in the database at all. */
  async getProblem(slug: string) {
    const p = await this.pool.query(
      `SELECT id, slug, title, difficulty, tags, statement_md, time_limit_ms, memory_limit_mb, checker
         FROM problems WHERE slug = $1`,
      [slug],
    );
    const row = p.rows[0];
    if (!row) return null;
    const s = await this.pool.query(
      `SELECT name, input, output FROM problem_samples WHERE problem_id = $1 ORDER BY seq`,
      [row.id],
    );
    const { id: _id, ...rest } = row;
    return { ...rest, samples: s.rows };
  }

  async problemIdBySlug(slug: string): Promise<number | null> {
    const r = await this.pool.query(`SELECT id FROM problems WHERE slug = $1`, [slug]);
    return r.rows[0] ? Number(r.rows[0].id) : null;
  }

  /**
   * Inserts a queued submission unless the user already has `maxActive`
   * queued|running ones (then returns null). Atomic: the user's row is locked
   * FOR UPDATE for the count + insert, so concurrent requests from one user
   * are serialized and can never exceed the cap together.
   */
  async insertSubmission(problemId: number, language: string, source: string, userId: number, maxActive: number): Promise<string | null> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const n = await c.query(
        `SELECT count(*)::int AS n FROM submissions WHERE user_id = $1 AND status IN ('queued', 'running')`,
        [userId],
      );
      if (n.rows[0].n >= maxActive) {
        await c.query("ROLLBACK");
        return null;
      }
      const r = await c.query(
        `INSERT INTO submissions (problem_id, language, source, user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [problemId, language, source, userId],
      );
      await c.query("COMMIT");
      return r.rows[0].id as string;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** Records a successful XADD: its stream entry id and when it happened. */
  async markEnqueued(id: string, entryId: string): Promise<void> {
    await this.pool.query(`UPDATE submissions SET enqueued_at = now(), stream_entry_id = $2 WHERE id = $1`, [id, entryId]);
  }

  async getSubmission(id: string) {
    const r = await this.pool.query(
      `SELECT s.id, p.slug AS problem_slug, s.language, s.status, s.verdict, s.reason,
              s.failed_test, s.failed_is_sample, s.max_cpu_ms, s.max_rss_kb, s.attempt,
              s.created_at, s.started_at, s.finished_at
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.id = $1`,
      [id],
    );
    const sub = r.rows[0];
    if (!sub) return null;
    // stdout is selected for sample rows only (the schema also forbids
    // storing it for hidden tests); hidden rows never carry output fields.
    const t = await this.pool.query(
      `SELECT seq, name, is_sample, status, cpu_ms, rss_kb,
              CASE WHEN is_sample THEN stdout END AS stdout,
              CASE WHEN is_sample THEN stdout_truncated END AS stdout_truncated
         FROM submission_tests WHERE submission_id = $1 ORDER BY seq`,
      [id],
    );
    const tests = t.rows.map((r) => {
      if (r.is_sample) return r;
      const { stdout: _o, stdout_truncated: _t, ...hidden } = r;
      return hidden;
    });
    return { ...sub, tests };
  }

  /**
   * Claims up to `limit` sweep candidates, stamping enqueued_at so concurrent
   * sweeps (or API instances) don't pick the same rows within `afterMs`, and
   * so a large backlog is checked in rotation rather than the oldest rows
   * over and over:
   *  - queued, older than `afterMs`, not stamped within `afterMs`. The caller
   *    re-enqueues it only if stream_entry_id is NULL (XADD failed) or that
   *    entry is gone from the stream; a submission still waiting in the
   *    stream is left alone (no duplicates under backlog);
   *  - running with started_at older than `runningAfterMs` and not stamped
   *    within `afterMs` (worker and its stream entry presumed lost).
   */
  async claimForReenqueue(
    afterMs: number,
    runningAfterMs: number,
    limit: number,
  ): Promise<{ id: string; status: "queued" | "running"; stream_entry_id: string | null }[]> {
    const r = await this.pool.query(
      `UPDATE submissions SET enqueued_at = now()
        WHERE id IN (
          SELECT id FROM submissions
           WHERE (enqueued_at IS NULL OR enqueued_at < now() - make_interval(secs => $1::double precision / 1000))
             AND (   (status = 'queued'  AND created_at < now() - make_interval(secs => $1::double precision / 1000))
                  OR (status = 'running' AND started_at < now() - make_interval(secs => $2::double precision / 1000)))
           ORDER BY created_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING id, status, stream_entry_id`,
      [afterMs, runningAfterMs, limit],
    );
    return r.rows;
  }

  /** Inserts or refreshes a GitHub user; returns users.id. */
  async upsertUser(githubId: number, login: string, avatarUrl: string | null): Promise<number> {
    const r = await this.pool.query(
      `INSERT INTO users (github_id, login, avatar_url) VALUES ($1, $2, $3)
       ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url
       RETURNING id`,
      [githubId, login, avatarUrl],
    );
    return Number(r.rows[0].id);
  }

  /** id is the SHA-256 hex of the session token (never the token itself). */
  async createSession(id: string, userId: number, ttlMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3::double precision / 1000))`,
      [id, userId, ttlMs],
    );
  }

  /**
   * Returns the user of a live (unexpired) session, renewing it (last_seen_at
   * = now, expires_at = now + ttl) when it was last renewed more than
   * renewAfterMs ago; null if the session is missing or expired.
   */
  async getSession(id: string, renewAfterMs: number, ttlMs: number): Promise<{ user: SessionUser; renewed: boolean } | null> {
    const r = await this.pool.query(
      `WITH renewed AS (
         UPDATE sessions
            SET last_seen_at = now(), expires_at = now() + make_interval(secs => $3::double precision / 1000)
          WHERE id = $1 AND expires_at > now()
            AND last_seen_at < now() - make_interval(secs => $2::double precision / 1000)
         RETURNING id)
       SELECT u.id, u.github_id, u.login, u.avatar_url, EXISTS (SELECT 1 FROM renewed) AS renewed
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [id, renewAfterMs, ttlMs],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      user: { id: Number(row.id), github_id: Number(row.github_id), login: row.login, avatar_url: row.avatar_url },
      renewed: row.renewed,
    };
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  }

  async deleteExpiredSessions(): Promise<number> {
    const r = await this.pool.query(`DELETE FROM sessions WHERE expires_at <= now()`);
    return r.rowCount ?? 0;
  }

  /**
   * What an Insights request needs about a submission, only if userId owns
   * it (else null): its problem's ladder, verdict and source.
   */
  async insightTarget(id: string, userId: number) {
    const r = await this.pool.query(
      `SELECT s.problem_id, s.language, s.source, s.status, s.verdict, p.ladder_hash, p.ladder_label, p.ladder_reference
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.id = $1 AND s.user_id = $2`,
      [id, userId],
    );
    return (r.rows[0] ?? null) as {
      problem_id: string;
      language: string;
      source: string;
      status: string;
      verdict: string | null;
      ladder_hash: string | null;
      ladder_label: string | null;
      ladder_reference: string | null;
    } | null;
  }

  /** The cached analysis for (problem, language, code, ladder), if any. */
  async getInsight(problemId: string, language: string, sha: Buffer, ladderHash: string, staleMs: number) {
    const r = await this.pool.query(
      `SELECT id, status, report, error, created_at, started_at, finished_at,
              (status IN ('queued', 'running') AND now() - created_at > make_interval(secs => $5 / 1000.0)) AS stale
         FROM insights WHERE problem_id = $1 AND language = $2 AND code_sha256 = $3 AND ladder_hash = $4`,
      [problemId, language, sha, ladderHash, staleMs],
    );
    return (r.rows[0] ?? null) as {
      id: string;
      status: string;
      report: unknown;
      error: string | null;
      stale: boolean;
    } | null;
  }

  /**
   * Queues an analysis: inserts it, or re-queues a failed or stale one (with
   * this submission as the source). Returns the id to enqueue, or null if
   * another request won the race and the existing row stands.
   */
  async queueInsight(
    problemId: string,
    language: string,
    sha: Buffer,
    ladderHash: string,
    submissionId: string,
    staleMs: number,
  ): Promise<string | null> {
    const r = await this.pool.query(
      `INSERT INTO insights (problem_id, language, code_sha256, ladder_hash, submission_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (problem_id, language, code_sha256, ladder_hash) DO UPDATE
          SET status = 'queued', submission_id = EXCLUDED.submission_id, report = NULL, error = NULL,
              created_at = now(), started_at = NULL, finished_at = NULL
        WHERE insights.status = 'failed'
           OR (insights.status IN ('queued', 'running') AND now() - insights.created_at > make_interval(secs => $6 / 1000.0))
       RETURNING id`,
      [problemId, language, sha, ladderHash, submissionId, staleMs],
    );
    return r.rows[0]?.id ?? null;
  }

  async isAdmin(userId: number): Promise<boolean> {
    const r = await this.pool.query(`SELECT is_admin FROM users WHERE id = $1`, [userId]);
    return r.rows[0]?.is_admin === true;
  }

  /** Finished submissions of a problem whose fingerprints are missing or from an older tokenizer. */
  async unfingerprinted(problemId: string, version: number, limit: number) {
    const r = await this.pool.query(
      `SELECT id, language, source FROM submissions
        WHERE problem_id = $1 AND status = 'done' AND fp_version IS DISTINCT FROM $2
        ORDER BY created_at LIMIT $3`,
      [problemId, version, limit],
    );
    return r.rows as { id: string; language: string; source: string }[];
  }

  async storeFingerprints(submissionId: string, problemId: string, version: number, fps: { hash: number; from: number; to: number }[]) {
    const c = await this.pool.connect(); // one connection: the statements form one transaction
    try {
      await c.query("BEGIN");
      await c.query(`DELETE FROM submission_fingerprints WHERE submission_id = $1`, [submissionId]);
      if (fps.length) {
        await c.query(
          `INSERT INTO submission_fingerprints (submission_id, problem_id, hash, line_from, line_to)
           SELECT $1, $2, h, f, t FROM unnest($3::int[], $4::int[], $5::int[]) AS x(h, f, t)
           ON CONFLICT DO NOTHING`,
          [submissionId, problemId, fps.map((f) => f.hash), fps.map((f) => f.from), fps.map((f) => f.to)],
        );
      }
      await c.query(`UPDATE submissions SET fp_version = $2 WHERE id = $1`, [submissionId, version]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Pairs of submissions by different users, in the same language family,
   * ranked by shared fingerprints / fingerprints of the smaller one. Hashes
   * in base (starter code) and hashes that at least commonMin distinct users
   * share (common idioms) are ignored.
   */
  async similarPairs(problemId: string, base: number[], commonMin: number, threshold: number, limit: number) {
    const r = await this.pool.query(
      `WITH fp AS (
         SELECT DISTINCT f.submission_id, f.hash, s.user_id,
                CASE WHEN s.language IN ('c', 'cpp') THEN 'c' ELSE s.language END AS fam
           FROM submission_fingerprints f JOIN submissions s ON s.id = f.submission_id
          WHERE f.problem_id = $1 AND NOT (f.hash = ANY($2::int[]))),
       common AS (SELECT hash FROM fp GROUP BY hash HAVING count(DISTINCT user_id) >= $3),
       f AS (SELECT * FROM fp WHERE hash NOT IN (SELECT hash FROM common)),
       sizes AS (SELECT submission_id, count(*) AS n FROM f GROUP BY 1),
       shared AS (
         SELECT a.submission_id AS a, b.submission_id AS b, count(*) AS k
           FROM f a JOIN f b ON a.hash = b.hash AND a.submission_id < b.submission_id
                              AND a.user_id <> b.user_id AND a.fam = b.fam
          GROUP BY 1, 2)
       SELECT sh.a, sh.b, sh.k::int AS shared, (sh.k::float / least(sa.n, sb.n)) AS similarity
         FROM shared sh JOIN sizes sa ON sa.submission_id = sh.a JOIN sizes sb ON sb.submission_id = sh.b
        WHERE sh.k::float / least(sa.n, sb.n) >= $4
        ORDER BY similarity DESC, shared DESC LIMIT $5`,
      [problemId, base, commonMin, threshold, limit],
    );
    return r.rows as { a: string; b: string; shared: number; similarity: number }[];
  }

  /** Hashes shared by at least commonMin distinct users on a problem. */
  async commonHashes(problemId: string, commonMin: number): Promise<number[]> {
    const r = await this.pool.query(
      `SELECT f.hash FROM submission_fingerprints f JOIN submissions s ON s.id = f.submission_id
        WHERE f.problem_id = $1 GROUP BY f.hash HAVING count(DISTINCT s.user_id) >= $2`,
      [problemId, commonMin],
    );
    return r.rows.map((x) => x.hash as number);
  }

  async distinctSubmitters(problemId: string): Promise<number> {
    const r = await this.pool.query(`SELECT count(DISTINCT user_id)::int AS n FROM submissions WHERE problem_id = $1`, [problemId]);
    return r.rows[0].n as number;
  }

  /** Two submissions with their authors, for the admin pair view. */
  async submissionsForAdmin(ids: string[]) {
    const r = await this.pool.query(
      `SELECT s.id, s.language, s.source, s.verdict, s.created_at, u.login, p.slug AS problem_slug, s.problem_id
         FROM submissions s JOIN users u ON u.id = s.user_id JOIN problems p ON p.id = s.problem_id
        WHERE s.id = ANY($1::uuid[])`,
      [ids],
    );
    return r.rows as { id: string; language: string; source: string; verdict: string; created_at: string; login: string; problem_slug: string; problem_id: string }[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
