/**
 * Forgetting a session, against a real Postgres.
 *
 * Two sessions of the same tenant: one is deleted, one stays. A fact said in
 * both stays, because the other session still says it; a fact said only in
 * the deleted one goes, and so does the entity that only it named. The other
 * tenant has a session with the very same id, and none of it is touched.
 *
 * Usage:  MEMORY_DATABASE_URL=postgres://... bun run test:integration
 */

import { expect, test } from "bun:test";
import postgres from "postgres";
import { createStubEmbedder } from "../doubles/embedders";
import { createMemory } from "../../src/memory";
import type { MigratingSql } from "../../src/migrations";

const url = process.env.MEMORY_DATABASE_URL;
if (!url) {
  throw new Error("MEMORY_DATABASE_URL is missing: the integration tests run against a Postgres with pgvector.");
}

const client = postgres(url, { onnotice: () => {} });
const SCHEMA = "memory_forget";
const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

function check(name: string, ok: boolean, detail = "") {
  test(name, () => expect(ok, detail).toBe(true));
}

await client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE EXTENSION IF NOT EXISTS vector;`);
const stub = createStubEmbedder();
const memory = await createMemory({ sql: client as unknown as MigratingSql, schema: SCHEMA, embedder: () => stub });

// What the extraction "finds" in each conversation, keyed by what was said.
const said: Record<string, { source: string; target: string; fact: string; since: null }[]> = {
  "gone": [
    { source: "user", target: "Rosario", fact: "The user lives in Rosario", since: null },
    { source: "user", target: "Kinesis", fact: "The user trains with Kinesis", since: null },
  ],
  "kept": [{ source: "user", target: "Rosario", fact: "The user lives in Rosario", since: null }],
};
const complete = async (prompt: string) => {
  if (!prompt.startsWith("You extract")) return "[]";
  return JSON.stringify(prompt.includes("SAID-gone") ? said.gone : said.kept);
};

async function converse(tenantId: string, sessionId: string, text: string) {
  const r = await memory.ingestConversation({
    tenantId,
    agent: "assistant",
    turns: [{ role: "user", text }],
    source: { kind: "conversation", sessionId, messageIdFrom: `${sessionId}:1`, messageIdTo: `${sessionId}:1` },
    complete,
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
}

await converse(A, "s-gone", "SAID-gone: I live in Rosario and train with Kinesis");
await converse(A, "s-kept", "SAID-kept: I live in Rosario");
await memory.remember({ tenantId: A, agent: "assistant", note: "answer briefly", sessionId: "s-gone" });
await memory.remember({ tenantId: A, agent: "assistant", note: "uses metric units", sessionId: "s-kept" });
await converse(B, "s-gone", "SAID-gone: I live in Rosario and train with Kinesis");
await memory.remember({ tenantId: B, agent: "assistant", note: "answer briefly", sessionId: "s-gone" });

const T = (table: string) => client.unsafe(`${SCHEMA}.${table}`);
async function counts(tenantId: string) {
  const [r] = await client`
    SELECT
      (SELECT count(*)::int FROM ${T("episodes")} WHERE tenant_id = ${tenantId}) AS episodes,
      (SELECT count(*)::int FROM ${T("facts")} WHERE tenant_id = ${tenantId}) AS facts,
      (SELECT count(*)::int FROM ${T("entities")} WHERE tenant_id = ${tenantId}) AS entities,
      (SELECT count(*)::int FROM ${T("agent_notes")} WHERE tenant_id = ${tenantId}) AS notes`;
  return r as { episodes: number; facts: number; entities: number; notes: number };
}

const before = await counts(A);
const beforeB = await counts(B);
check("the setup holds what the test needs", before.episodes === 2 && before.facts === 2 && before.entities === 3 && before.notes === 2,
  JSON.stringify(before));

// ─── A dry run says what would go and leaves everything ─────────────────────

const preview = await memory.forgetSessions(A, ["s-gone"], { dryRun: true });
check("the dry run names the session's note", preview.notes.map((n) => n.note).join() === "answer briefly", JSON.stringify(preview.notes));
check("and its episode", preview.episodes.length === 1, JSON.stringify(preview.episodes));
check("and only the fact that came from it alone", preview.facts.map((f) => f.fact).join() === "The user trains with Kinesis",
  JSON.stringify(preview.facts));
check("and the entity left with no fact", preview.entities.map((e) => e.name).join() === "Kinesis", JSON.stringify(preview.entities));
check("and removes nothing", JSON.stringify(await counts(A)) === JSON.stringify(before), JSON.stringify(await counts(A)));

// ─── Forgetting takes out what the dry run said ─────────────────────────────

const gone = await memory.forgetSessions(A, ["s-gone"]);
check("it takes out what the dry run said", JSON.stringify(gone) === JSON.stringify(preview), JSON.stringify(gone));

const after = await counts(A);
check("the tenant keeps the other session's episode, fact and note",
  after.episodes === 1 && after.facts === 1 && after.notes === 1 && after.entities === 2, JSON.stringify(after));

const [kept] = await client`
  SELECT f.fact, count(fe.episode_id)::int AS episodes
  FROM ${T("facts")} f JOIN ${T("fact_episodes")} fe ON fe.fact_id = f.id
  WHERE f.tenant_id = ${A} GROUP BY f.fact`;
check("the fact the other session also said stays, linked only to it",
  kept?.fact === "The user lives in Rosario" && kept?.episodes === 1, JSON.stringify(kept));

check("the other tenant's same session id is untouched", JSON.stringify(await counts(B)) === JSON.stringify(beforeB),
  JSON.stringify(await counts(B)));

const again = await memory.forgetSessions(A, ["s-gone"]);
check("forgetting it again finds nothing",
  again.notes.length + again.episodes.length + again.facts.length + again.entities.length === 0, JSON.stringify(again));

await client.unsafe(`DROP SCHEMA ${SCHEMA} CASCADE`);
await client.end();
