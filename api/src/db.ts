import pg from "pg";

/** All SQL here is parameterized; no string interpolation of values. */
export class Db {
  constructor(readonly pool: pg.Pool) {}

  static connect(url: string, max: number): Db {
    return new Db(new pg.Pool({ connectionString: url, max }));
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async listProblems() {
    const r = await this.pool.query(
      `SELECT slug, title, time_limit_ms, memory_limit_mb FROM problems ORDER BY slug`,
    );
    return r.rows;
  }

  /** Statement + public samples only. Hidden tests are not in the database at all. */
  async getProblem(slug: string) {
    const p = await this.pool.query(
      `SELECT id, slug, title, statement_md, time_limit_ms, memory_limit_mb, checker
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

  async insertSubmission(problemId: number, language: string, source: string): Promise<string> {
    const r = await this.pool.query(
      `INSERT INTO submissions (problem_id, language, source) VALUES ($1, $2, $3) RETURNING id`,
      [problemId, language, source],
    );
    return r.rows[0].id as string;
  }

  async markEnqueued(id: string): Promise<void> {
    await this.pool.query(`UPDATE submissions SET enqueued_at = now() WHERE id = $1`, [id]);
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
    const t = await this.pool.query(
      `SELECT seq, name, is_sample, status, cpu_ms, rss_kb
         FROM submission_tests WHERE submission_id = $1 ORDER BY seq`,
      [id],
    );
    return { ...sub, tests: t.rows };
  }

  /**
   * Claims up to `limit` submissions that are still queued and have not been
   * (re)enqueued within `afterMs`, stamping enqueued_at so concurrent sweeps
   * (or API instances) don't pick the same rows. Returns their ids.
   */
  async claimForReenqueue(afterMs: number, limit: number): Promise<string[]> {
    const r = await this.pool.query(
      `UPDATE submissions SET enqueued_at = now()
        WHERE id IN (
          SELECT id FROM submissions
           WHERE status = 'queued'
             AND created_at < now() - make_interval(secs => $1::double precision / 1000)
             AND (enqueued_at IS NULL OR enqueued_at < now() - make_interval(secs => $1::double precision / 1000))
           ORDER BY created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [afterMs, limit],
    );
    return r.rows.map((x) => x.id as string);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
