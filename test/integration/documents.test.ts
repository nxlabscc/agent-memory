/**
 * Verification of the document index against a real Postgres.
 *
 * Usage:  MEMORY_DATABASE_URL=postgres://... bun run test:integration
 */

import { expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations, type MigratingSql } from "../../src/migrations";
import { createDocumentIndex } from "../../src/documents";
import type { Sql } from "../../src/store";

const url = process.env.MEMORY_DATABASE_URL;
if (!url) {
  throw new Error("MEMORY_DATABASE_URL is missing: the integration tests run against a Postgres with pgvector.");
}

const client = postgres(url, { onnotice: () => {} });
const SCHEMA = process.env.MEMORY_SCHEMA ?? "memory";
const docs = createDocumentIndex(client as unknown as Sql, SCHEMA);

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vector = (seed: number) => Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) / 28);

/**
 * Each check is a test. The operations run in order when the file loads,
 * against the same database; this records the result of each one.
 */
function check(name: string, ok: boolean, detail = "") {
  test(name, () => expect(ok, detail).toBe(true));
}

await client.unsafe(
  `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION vector;`,
);
await applyMigrations(client as unknown as MigratingSql, SCHEMA);

const march = new Date("2026-03-01T00:00:00Z");
const july = new Date("2026-07-01T00:00:00Z");

await docs.upsert(A, {
  id: uuid(1),
  externalId: "page-tasks",
  title: "Tasks",
  toc: "# Tasks",
  extra: { views: [{ name: "Today", viewId: "v#0" }, { name: "Inbox", viewId: "v#1" }] },
  embedding: vector(1),
  embeddingModel: "test",
  sourceUpdatedAt: march,
});
await docs.upsert(A, {
  id: uuid(2),
  externalId: "page-project",
  title: "Memory-Library",
  extra: { databaseId: "db-projects", properties: { status: "Active", area: "Home" } },
  embedding: vector(2),
  embeddingModel: "test",
  sourceUpdatedAt: july,
});
await docs.upsert(B, {
  id: uuid(3),
  externalId: "page-tasks",
  title: "Someone else's tasks",
  extra: { views: [{ name: "Today", viewId: "x#0" }] },
  embedding: vector(3),
  embeddingModel: "test",
  sourceUpdatedAt: july,
});

// ─── The basics ──────────────────────────────────────────────────────────────

const all = await docs.list(A);
check("list returns the tenant's documents, by title", all.map((d) => d.title).join(",") === "Memory-Library,Tasks");
const tasks = all.find((d) => d.externalId === "page-tasks")!;
const views = tasks.extra.views as { viewId: string }[];
check(
  "and extra comes back as it was stored",
  views.length === 2 && views[0]!.viewId === "v#0",
  JSON.stringify(tasks.extra),
);

const byVector = await docs.byVector(A, vector(2), "test", 5);
check("byVector finds and orders by closeness", byVector[0]?.externalId === "page-project");
// By field and not by serialized JSON: jsonb reorders the keys.
const properties = byVector[0]?.extra.properties as Record<string, string> | undefined;
check(
  "and returns extra, which is the answer and not what is matched",
  properties?.status === "Active" && properties?.area === "Home",
  JSON.stringify(byVector[0]?.extra),
);
check("byVector with another model finds nothing", (await docs.byVector(A, vector(2), "other", 5)).length === 0);

const byText = await docs.byText(A, "Tasks");
check("byText finds by title", byText.some((d) => d.externalId === "page-tasks"));
check("byText does not search extra", (await docs.byText(A, "Active")).length === 0);

// ─── Isolation ───────────────────────────────────────────────────────────────
//
// Both tenants have a document with the SAME external id: uniqueness is per
// (tenant, document), not global.

check("two tenants can have the same external id", (await docs.list(B)).length === 1);
check(
  "and each sees its own",
  (await docs.list(B))[0]!.title === "Someone else's tasks",
);
check("byVector does not cross tenants", (await docs.byVector(B, vector(2), "test", 5)).every((d) => d.tenantId === B));
check("byText does not either", (await docs.byText(B, "Memory-Library")).length === 0);

// ─── Reindex and forget ──────────────────────────────────────────────────────

await docs.upsert(A, {
  id: uuid(9),
  externalId: "page-project",
  title: "Memory-Library (renamed)",
  extra: { databaseId: "db-projects" },
  sourceUpdatedAt: new Date("2026-09-01T00:00:00Z"),
});
const after = await docs.byText(A, "renamed");
check("going over a page again overwrites it, does not duplicate it", after.length === 1, `${after.length} rows`);

check(
  "lastIndexedAt is the newest thing seen",
  (await docs.lastIndexedAt(A))?.toISOString() === "2026-09-01T00:00:00.000Z",
);

await docs.forget(A, ["page-project"]);
check("forgetting takes the page out of the index", (await docs.byText(A, "renamed")).length === 0);
check("and does not touch the other tenant's", (await docs.list(B)).length === 1);

await client.end();
