/**
 * Server startup, once per process.
 *
 * Next calls `register()` before the first request is served, which is the
 * only place two things can happen exactly once and in order: the schema is
 * applied, and only then is the old SQLite database imported. Doing either
 * lazily from a request handler would let two concurrent requests race into
 * `CREATE TABLE` or, worse, into two half-imports.
 *
 * The backend is the only service allowed to do this. DEPLOYMENT.md says so
 * and the frontend's own `pg.ts` refuses on purpose: a second writer creating
 * tables is how a database ends up with two disagreeing shapes.
 */
export async function register(): Promise<void> {
  // Next runs this hook in the edge runtime too, where node:fs and pg do not
  // exist. The imports are dynamic so that build never resolves them there.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { migrate } = await import("./lib/pg");
  await migrate();

  // After the schema, never before: the import writes rows into tables that
  // have to exist first.
  const { importLegacy } = await import("./lib/import-legacy");
  await importLegacy();
}
