/**
 * Verification of migration 008 over data that is already there: a database
 * whose document index is in its old shape —a client-specific page, with
 * columns for where it lives, its properties and its views— moves to the
 * generic shape without losing anything.
 *
 * Usage:  MEMORY_DATABASE_URL=postgres://... bun run test:integration
 */

import { expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations, migrations, type MigratingSql } from "../../src/migrations";

const url = process.env.MEMORY_DATABASE_URL;
if (!url) {
  throw new Error("MEMORY_DATABASE_URL is missing: the integration tests run against a Postgres with pgvector.");
}

const client = postgres(url, { onnotice: () => {} });
const SCHEMA = "memory";
const A = "aaaaaaaa-0000-0000-0000-00000000000a";

/**
 * Each check is a test. The operations run in order when the file loads,
 * against the same database; this records the result of each one.
 */
function check(name: string, ok: boolean, detail = "") {
  test(name, () => expect(ok, detail).toBe(true));
}

await client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE EXTENSION IF NOT EXISTS vector;`);

// The database as it was: up to 007, with its tracking table, as an earlier
// client left it.
await client.unsafe(`CREATE SCHEMA ${SCHEMA}`);
await client.unsafe(`CREATE TABLE ${SCHEMA}.schema_migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
for (const m of migrations(SCHEMA).filter((m) => m.name < "008")) {
  await client.unsafe(m.sql);
  await client`INSERT INTO ${client.unsafe(`${SCHEMA}.schema_migrations`)} (name) VALUES (${m.name})`;
}

await client.unsafe(`
  INSERT INTO ${SCHEMA}.document_index
    (id, tenant_id, page_id, title, parent_id, database_id, toc, properties, views, source_updated_at)
  VALUES
    ('00000000-0000-4000-8000-000000000001', '${A}', 'row-1', 'Call the dentist', NULL, 'db-tasks', '',
     '{"Status":"Inbox"}', '[]', '2026-09-01T00:00:00Z'),
    ('00000000-0000-4000-8000-000000000002', '${A}', 'page-1', 'Tasks', 'root-1', NULL, '## Today',
     '{}', '[{"name":"Today","viewId":"v#0"}]', NULL)`);
await client.unsafe(`INSERT INTO ${SCHEMA}.crawl_state (tenant_id, last_run_at) VALUES ('${A}', now())`);

const applied = await applyMigrations(client as unknown as MigratingSql, SCHEMA);
check("applies only the missing one", applied.join(",") === "008_generic_document.sql", applied.join(","));

const rows = await client<{ external_id: string; title: string; toc: string; extra: Record<string, unknown> }[]>`
  SELECT external_id, title, toc, extra FROM ${client.unsafe(`${SCHEMA}.document_index`)} ORDER BY external_id`;
const row = rows.find((f) => f.external_id === "row-1");
const page = rows.find((f) => f.external_id === "page-1");

check("the page id becomes the external id", row !== undefined && page !== undefined);
check(
  "the row carries its database and its properties in extra",
  row?.extra.databaseId === "db-tasks" && (row?.extra.properties as Record<string, string>)?.Status === "Inbox",
  JSON.stringify(row?.extra),
);
check(
  "the page carries its parent and its views",
  page?.extra.parentId === "root-1" && (page?.extra.views as { viewId: string }[])?.[0]?.viewId === "v#0",
  JSON.stringify(page?.extra),
);
check("what was null does not show up", row !== undefined && !("parentId" in row.extra));
check("title and outline stay as they were", page?.title === "Tasks" && page?.toc === "## Today");

const columns = (await client<{ column_name: string }[]>`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = ${SCHEMA} AND table_name = 'document_index'`).map((c) => c.column_name);
check(
  "the client-specific columns are gone",
  ["page_id", "parent_id", "database_id", "properties", "views"].every((c) => !columns.includes(c)),
  columns.join(","),
);

const [state] = await client`SELECT to_regclass(${`${SCHEMA}.crawl_state`}) AS t`;
check("the crawler state left the memory", state!.t === null);

await client.end();
