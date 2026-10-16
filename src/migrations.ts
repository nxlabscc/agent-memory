/**
 * Migrations for the memory store.
 *
 * They are applied by `applyMigrations`, which is what `createMemory` runs when
 * opening the memory: it creates the schema if it does not exist and applies
 * whatever is missing. The SQL names its tables as `{{schema}}.table` and the
 * name is filled in when applying, so the same list works for any schema.
 */

import memoryStore from "./migrations/001_memory_store.sql" with { type: "text" };
import embeddingDimensions from "./migrations/002_embedding_dimensions.sql" with { type: "text" };
import documentIndex from "./migrations/003_document_index.sql" with { type: "text" };
import agentNotes from "./migrations/004_agent_notes.sql" with { type: "text" };
import noteAuthor from "./migrations/005_note_author.sql" with { type: "text" };
import crawlState from "./migrations/006_crawl_state.sql" with { type: "text" };
import memoryPerAgent from "./migrations/007_memory_per_agent.sql" with { type: "text" };
import genericDocument from "./migrations/008_generic_document.sql" with { type: "text" };
import { DEFAULT_SCHEMA, requireSchema, type Sql } from "./store";

export interface Migration {
  /** The file name. It is the key used to track what has been applied. */
  name: string;
  sql: string;
}

// The SQL travels inside the module, as text, rather than as files next to the
// executable. That is what keeps the library from demanding anything of whoever
// imports it: once bundled into another component, a path relative to this
// file would point into the consumer's bundle.
//
// Forward-only: a published migration is never edited, a new one is added
// with its own import.
const all: Migration[] = [
  { name: "001_memory_store.sql", sql: memoryStore },
  { name: "002_embedding_dimensions.sql", sql: embeddingDimensions },
  { name: "003_document_index.sql", sql: documentIndex },
  { name: "004_agent_notes.sql", sql: agentNotes },
  { name: "005_note_author.sql", sql: noteAuthor },
  { name: "006_crawl_state.sql", sql: crawlState },
  { name: "007_memory_per_agent.sql", sql: memoryPerAgent },
  { name: "008_generic_document.sql", sql: genericDocument },
];

/** Migrations in application order, with the schema already filled in. */
export function migrations(schema: string = DEFAULT_SCHEMA): Migration[] {
  const s = requireSchema(schema);
  return all.map((m) => ({ name: m.name, sql: m.sql.replaceAll("{{schema}}", s) }));
}

/** The client with transactions: applying migrations needs to pin a connection. */
export type MigratingSql = Sql & {
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
};

/**
 * Creates the schema if it does not exist and applies any pending migrations.
 *
 * Progress is tracked in `<schema>.schema_migrations`. Returns the names of
 * the migrations it applied, empty if it was already up to date.
 * EVERYTHING runs inside one transaction, and not only for atomicity: a
 * Postgres advisory lock belongs to the **connection** that takes it, and the
 * client is usually a pool. Taking it with one query and releasing it with
 * another sends each over whichever connection is free: the unlock lands on
 * one that does not hold it, silently returns false, and the lock stays held
 * until that connection dies. The transaction pins one connection for both
 * ends, and `_xact_` releases on finish —also if the process dies midway—.
 *
 * And the lock goes FIRST, before creating the schema. `IF NOT EXISTS` is not
 * atomic against someone else creating the same thing at that instant: two
 * processes starting together both check, both create, and the second one
 * fails on the unique index of `pg_namespace`. The key is derived from the
 * schema name, so two memories in different schemas do not wait on each other.
 *
 * Extensions (`vector`) belong to the database, not to the memory: 001 asks
 * for it with IF NOT EXISTS, but having it installed is the database's job.
 */
export async function applyMigrations(
  sql: MigratingSql,
  schema: string = DEFAULT_SCHEMA,
): Promise<string[]> {
  const s = requireSchema(schema);
  const applied: string[] = [];

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`memory-migrations:${s}`}))`;

    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const alreadyApplied = new Set(
      (await tx<{ name: string }>`SELECT name FROM ${tx.unsafe(`${s}.schema_migrations`)}`).map((row) => row.name),
    );

    for (const migration of migrations(s)) {
      if (alreadyApplied.has(migration.name)) continue;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO ${tx.unsafe(`${s}.schema_migrations`)} (name) VALUES (${migration.name})`;
      applied.push(migration.name);
    }
  });

  return applied;
}
