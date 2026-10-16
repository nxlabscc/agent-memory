/**
 * Verification of search against a real Postgres.
 *
 * What matters here and cannot be checked with a fake client: that the
 * recursive traversal **does not cross tenants**. The filter has to be in the
 * base term and in the recursive one; if it is missing from the recursive term,
 * from the second hop on the traversal wanders into anyone's facts.
 *
 * Usage:  MEMORY_DATABASE_URL=postgres://... bun run test:integration
 */

import { expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations, type MigratingSql } from "../../src/migrations";
import { createMemorySearch } from "../../src/search";
import { createMemoryStore, type Sql } from "../../src/store";

const url = process.env.MEMORY_DATABASE_URL;
if (!url) {
  throw new Error("MEMORY_DATABASE_URL is missing: the integration tests run against a Postgres with pgvector.");
}

const client = postgres(url, { onnotice: () => {} });
/** Which schema: the default one, or another to show the memory does not depend on the name. */
const SCHEMA = process.env.MEMORY_SCHEMA ?? "memory";
const sql = client as unknown as Sql;
const store = createMemoryStore(sql, SCHEMA);
const search = createMemorySearch(sql, SCHEMA);

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const march = new Date("2026-03-01T00:00:00Z");
const july = new Date("2026-07-01T00:00:00Z");

/**
 * Each check is a test. The operations run in order when the file loads,
 * against the same database; this records the result of each one.
 */
function check(name: string, ok: boolean, detail = "") {
  test(name, () => expect(ok, detail).toBe(true));
}

await client.unsafe(
  `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION vector;`);
await applyMigrations(client as unknown as MigratingSql, SCHEMA);

// ─── Data ────────────────────────────────────────────────────────────────────
//
// Tenant A: Ana → Atlas → Memory, a two-hop chain.
// Tenant B: an entity and a fact of its own.

const names: Record<number, string> = {
  1: "Ana", 2: "Atlas", 3: "Memory",
  101: "Bob", 102: "OtherThing",
};
for (const [n, name] of Object.entries(names)) {
  const num = Number(n);
  await store.insertEntity(num < 100 ? A : B, {
    id: id(num),
    name,
    normalizedName: name.toLowerCase(),
  });
}

await store.insertFact(A, {
  id: id(10), sourceEntityId: id(1), targetEntityId: id(2),
  fact: "Ana works on Atlas", validAt: march, agent: "assistant", episodeIds: [],
});
await store.insertFact(A, {
  id: id(11), sourceEntityId: id(2), targetEntityId: id(3),
  fact: "Atlas has memory", validAt: march, agent: "assistant", episodeIds: [],
});
await store.insertFact(B, {
  id: id(110), sourceEntityId: id(101), targetEntityId: id(102),
  fact: "Bob works on OtherThing", validAt: march, agent: "assistant", episodeIds: [],
});

// ─── Full-text ───────────────────────────────────────────────────────────────

const byText = await search.factsByText(A, "assistant", "Ana");
check("full-text finds the fact", byText.length === 1 && byText[0]!.id === id(10));

const foreignText = await search.factsByText(A, "assistant", "Bob");
check("full-text does not return another tenant's facts", foreignText.length === 0);

// ─── Traversal ───────────────────────────────────────────────────────────────

const oneHop = await search.factsByTraversal(A, "assistant", [id(1)], { maxDepth: 1 });
check(
  "a 1-hop traversal reaches the direct fact",
  oneHop.some((f) => f.id === id(10)),
  oneHop.map((f) => f.fact).join(" / "),
);

const twoHops = await search.factsByTraversal(A, "assistant", [id(1)], { maxDepth: 2 });
check(
  "a 2-hop traversal reaches the indirect fact",
  twoHops.some((f) => f.id === id(11)),
  twoHops.map((f) => f.fact).join(" / "),
);

check(
  "the traversal never brings another tenant's facts",
  twoHops.every((f) => f.tenantId === A),
  [...new Set(twoHops.map((f) => f.tenantId))].join(","),
);

// The case the schema has to make impossible: a fact of B pointing at an entity
// of A. Without the composite FK it would get in, and from there A's traversal
// would have a way across.
let rejected = false;
try {
  await store.insertFact(B, {
    id: id(120), sourceEntityId: id(1), targetEntityId: id(102),
    fact: "a fact of B pointing at an entity of A", validAt: march, agent: "assistant", episodeIds: [],
  });
} catch {
  rejected = true;
}
check("a fact cannot point at another tenant's entities", rejected);

// ─── Validity ────────────────────────────────────────────────────────────────

await store.invalidateFact(A, id(10), july, new Date());

const inSeptember = await search.factsByText(A, "assistant", "Ana", {
  at: new Date("2026-09-01T00:00:00Z"),
});
check("with `at`, a closed fact does not show up", inSeptember.length === 0);

const inMay = await search.factsByText(A, "assistant", "Ana", {
  at: new Date("2026-05-01T00:00:00Z"),
});
check("and it does show up inside its window", inMay.length === 1);

const withoutAt = await search.factsByText(A, "assistant", "Ana");
check("without `at` there is no validity filter", withoutAt.length === 1);

// ─── Hybrid ──────────────────────────────────────────────────────────────────

const hybrid = await search.hybrid(A, "assistant", { text: "Ana", seedEntityIds: [id(2)] });
check(
  "hybrid fuses without duplicates",
  new Set(hybrid.map((f) => f.id)).size === hybrid.length && hybrid.length > 0,
  `${hybrid.length} facts`,
);
check("hybrid does not cross tenants either", hybrid.every((f) => f.tenantId === A));

await client.end();
