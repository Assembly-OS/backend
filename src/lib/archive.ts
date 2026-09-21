import type { Tx } from "./pg";

/**
 * Names who is deleting, for the archive.
 *
 * Every row removed from the memory tables is copied whole into `archive` by a
 * trigger in the database (see `db/schema.postgres.sql`), whatever removed it.
 * The trigger cannot know which person asked — the database sees one pooled
 * connection — so a delete that wants to be attributed says so first, inside
 * the same transaction. `set_config(…, true)` is local to that transaction:
 * it cannot leak onto the next request that borrows the connection.
 *
 * A delete that skips this is still archived, with `archived_by` NULL. That is
 * the honest record of a delete nobody put a name to, rather than a guess.
 */
export async function actingAs(q: Tx, userId: number): Promise<void> {
  await q.run("SELECT set_config('app.user_id', ?, true)", String(userId));
}
