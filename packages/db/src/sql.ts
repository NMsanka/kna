import { sql, type SQL } from 'drizzle-orm';

/**
 * Bind a JavaScript array as a single Postgres array parameter.
 *
 * Drizzle's `sql` template does not treat an array value as one parameter — it *spreads* it,
 * emitting one placeholder per element with no separator. So `sql\`c.id = ANY(${ids})\`` compiles
 * to `ANY($1)` for one id and `ANY($1, $2)` for two, and Postgres rejects both:
 *
 *   malformed array literal: "chk_1a2b..."      -- one element: a text param where an array was expected
 *   op ANY/ALL (array) requires array on right side  -- more than one
 *
 * The bug is invisible in review (the template reads exactly like the SQL you meant) and
 * invisible in unit tests that mock the database. It only appears against a real Postgres, and
 * only on the code path that happens to have a non-empty array — which is why it survived a
 * clean build, a clean lint and a full test run before failing every indexing job at once.
 *
 * `sql.param()` marks the value as one bound parameter, which is what was intended everywhere.
 * Use this helper rather than `sql.param` directly so the reason stays attached to the call.
 *
 * An empty array is valid: `ANY('{}')` matches nothing, which is the correct answer for
 * "is this in the empty set" and avoids branching at every call site.
 */
export function anyOf(values: readonly unknown[]): SQL {
  return sql`ANY(${sql.param([...values])})`;
}
