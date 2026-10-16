/**
 * Verification of the store against a real Postgres.
 *
 * The unit tests use a fake client: they check that the query mentions
 * `tenant_id`, which is what can be checked without a database. This checks
 * the rest: that the SQL runs and that isolation **actually holds**.
 *
 * It is an integration test and runs separately from the unit tests: it needs
 * a Postgres, and the CI unit job has none.
 *
 * Usage:  MEMORY_DATABASE_URL=postgres://... bun run test:integration
 */

import { expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations, type MigratingSql } from "../../src/migrations";
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

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
  `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION vector;`,
);
await applyMigrations(client as unknown as MigratingSql, SCHEMA);

// ─── Data: both tenants with same-named entities ─────────────────────────────

for (const [tenant, base] of [[A, 1], [B, 100]] as const) {
  await store.insertEpisode(tenant, {
    id: uuid(base),
    source: { kind: "conversation", sessionId: "s1", messageIdFrom: "1", messageIdTo: "2" },
    contentSha256: `hash-${base}`,
    validAt: march,
  });
  await store.insertEntity(tenant, {
    id: uuid(base + 1),
    name: "Memory Project",
    normalizedName: "memory project",
  });
  await store.insertEntity(tenant, {
    id: uuid(base + 2),
    name: "Ana",
    normalizedName: "ana",
  });
  await store.insertFact(tenant, {
    id: uuid(base + 3),
    sourceEntityId: uuid(base + 2),
    targetEntityId: uuid(base + 1),
    fact: `Ana works on Memory Project (${tenant === A ? "A" : "B"})`,
    validAt: march, agent: "assistant",
    episodeIds: [uuid(base)],
  });
}

// ─── Isolation ───────────────────────────────────────────────────────────────

const candidatesA = await store.candidateEntities(A);
check(
  "candidateEntities only returns the tenant's entities",
  candidatesA.length === 2 && candidatesA.every((e) => e.tenantId === A),
  `${candidatesA.length} entities, tenants ${[...new Set(candidatesA.map((e) => e.tenantId))]}`,
);

check(
  "same-named entities of A and B were not merged",
  candidatesA.filter((e) => e.name === "Memory Project").length === 1,
);

const factsA = await store.factsValidAt(A, "assistant", march);
check(
  "factsValidAt does not cross tenants",
  factsA.length === 1 && factsA[0]!.tenantId === A,
  factsA.map((f) => f.fact).join(" / "),
);

check(
  "provenance comes back with the fact",
  factsA[0]?.episodeIds.length === 1 && factsA[0]!.episodeIds[0] === uuid(1),
);

// The other tenant's id exists, but asking for it from A does not bring it.
const foreignEpisodes = await store.getEpisodes(A, [uuid(100)]);
check("getEpisodes with another tenant's id returns nothing", foreignEpisodes.length === 0);

// Linking another tenant's episode is rejected by the database, not silently ignored.
let linkRejected = false;
try {
  await store.insertFact(A, {
    id: uuid(50),
    sourceEntityId: uuid(2),
    targetEntityId: uuid(3),
    fact: "fact with foreign provenance",
    validAt: march, agent: "assistant",
    episodeIds: [uuid(100)],
  });
} catch {
  linkRejected = true;
}
check("linking another tenant's episode is rejected by the database", linkRejected);

// And a summary cannot point at another tenant's episodes either.
let summaryRejected = false;
try {
  await client`
    INSERT INTO ${client.unsafe(`${SCHEMA}.summaries`)} (id, tenant_id, summary, first_episode_id, last_summarized_at)
    VALUES (${uuid(60)}, ${A}, 'cross-tenant summary', ${uuid(100)}, now())
  `;
} catch {
  summaryRejected = true;
}
check("a summary cannot point at another tenant's episodes", summaryRejected);

// ─── Bitemporality ───────────────────────────────────────────────────────────

await store.invalidateFact(A, uuid(4), july, new Date());

const inMay = await store.factsValidAt(A, "assistant", new Date("2026-05-01T00:00:00Z"));
check("a closed fact is still valid before its closing", inMay.some((f) => f.id === uuid(4)));

const inSeptember = await store.factsValidAt(A, "assistant", new Date("2026-09-01T00:00:00Z"));
check("and stops being valid after it", !inSeptember.some((f) => f.id === uuid(4)));

const [row] = await client<{ invalid_at: Date; expired_at: Date }[]>`
  SELECT invalid_at, expired_at FROM ${client.unsafe(`${SCHEMA}.facts`)} WHERE id = ${uuid(4)}
`;
check(
  "invalidating does not delete: the row stays, with both axes set",
  row !== undefined && row.invalid_at !== null && row.expired_at !== null,
);

// ─── The guard cannot be bypassed from outside ───────────────────────────────

try {
  await store.factsValidAt("", "assistant", march);
  check("an operation without a tenant never reaches the database", false);
} catch (error) {
  check(
    "an operation without a tenant never reaches the database",
    (error as Error).name === "TenantRequiredError",
  );
}

await client.end();
