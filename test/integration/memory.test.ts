/**
 * Verification of the opened memory (`createMemory`) against a real Postgres.
 *
 * It is the assembled path end to end: opening it creates the schema and the
 * tables, handing over a conversation leaves facts, handing over already-stated
 * facts does too, a note is stored with its vector, documents get indexed, and
 * `recall` finds all of that by searching with text. The client never touches a
 * vector.
 *
 * It runs in a schema that is NOT `memory`, to show that nothing depends on the
 * name.
 *
 * Usage:  MEMORY_DATABASE_URL=postgres://... bun run test:integration
 */

import { expect, test } from "bun:test";
import postgres from "postgres";
import type { EmbeddingProvider } from "../../src/embedding";
import { createStubEmbedder } from "../doubles/embedders";
import { createMemory } from "../../src/memory";
import type { MigratingSql } from "../../src/migrations";

const url = process.env.MEMORY_DATABASE_URL;
if (!url) {
  throw new Error("MEMORY_DATABASE_URL is missing: the integration tests run against a Postgres with pgvector.");
}

const client = postgres(url, { onnotice: () => {} });
const SCHEMA = process.env.MEMORY_SCHEMA ?? "memory_elsewhere";

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

/**
 * Each check is a test. The operations run in order when the file loads,
 * against the same database; this records the result of each one.
 */
function check(name: string, ok: boolean, detail = "") {
  test(name, () => expect(ok, detail).toBe(true));
}

await client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE EXTENSION IF NOT EXISTS vector;`);

// How many texts each tenant embedded: it is what the client pays for, and what
// tells whether a search embedded the query once or three times.
const embeddedCount = new Map<string, number>();
const stub = createStubEmbedder();
function embedderFor(tenantId: string): EmbeddingProvider {
  const add = (n: number) => embeddedCount.set(tenantId, (embeddedCount.get(tenantId) ?? 0) + n);
  return {
    dimensions: stub.dimensions,
    name: stub.name,
    async embed(text) {
      add(1);
      return stub.embed(text);
    },
    async embedBatch(texts) {
      add(texts.length);
      return stub.embedBatch(texts);
    },
  };
}

const logged: string[] = [];
const open = () =>
  createMemory({
    sql: client as unknown as MigratingSql,
    schema: SCHEMA,
    embedder: embedderFor,
    log: (message) => logged.push(message),
  });

// ─── Opening ─────────────────────────────────────────────────────────────────

const memory = await open();
const [schemaRow] = await client`SELECT 1 FROM pg_namespace WHERE nspname = ${SCHEMA}`;
check("opening creates the schema", schemaRow !== undefined);
const applied = await client`SELECT count(*)::int AS n FROM ${client.unsafe(`${SCHEMA}.schema_migrations`)}`;
check("and applies every migration", applied[0]!.n === 8, `${applied[0]!.n} applied`);
check("logging each one", logged.filter((a) => a === "migration applied").length === 8);

logged.length = 0;
await open();
check("opening it again applies nothing", logged.length === 0);

// Two processes starting at the same time: the lock makes one wait for the other.
await client.unsafe(`DROP SCHEMA ${SCHEMA} CASCADE`);
const concurrent = await Promise.allSettled([open(), open(), open()]);
check("three concurrent opens do not step on each other", concurrent.every((r) => r.status === "fulfilled"),
  concurrent.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)).join(" | "));

// ─── A conversation goes in, facts come out ──────────────────────────────────

const extraction = JSON.stringify([
  { source: "user", target: "Rosario", fact: "The user lives in Rosario", since: null },
  { source: "user", target: "TypeScript", fact: "The user prefers TypeScript", since: null },
]);
const prompts: string[] = [];
const complete = async (prompt: string) => {
  prompts.push(prompt);
  return prompt.startsWith("You extract") ? extraction : "[]";
};

const ingested = await memory.ingestConversation({
  tenantId: A,
  agent: "assistant",
  turns: [
    { role: "user", text: "I live in Rosario and I prefer TypeScript" },
    { role: "assistant", text: "noted" },
  ],
  source: { kind: "conversation", sessionId: "s1", messageIdFrom: "s1:0", messageIdTo: "s1:1" },
  complete,
});
check("the conversation leaves its facts", ingested.ok && ingested.facts === 2, JSON.stringify(ingested));

const repeated = await memory.ingestConversation({
  tenantId: A,
  agent: "assistant",
  turns: [{ role: "user", text: "again: I live in Rosario and I prefer TypeScript" }],
  source: { kind: "conversation", sessionId: "s2", messageIdFrom: "s2:0", messageIdTo: "s2:0" },
  complete,
});
check("saying it again opens no new facts", repeated.ok && repeated.facts === 0, JSON.stringify(repeated));

const unreadable = await memory.ingestConversation({
  tenantId: A,
  agent: "assistant",
  turns: [{ role: "user", text: "hello" }],
  source: { kind: "conversation", sessionId: "s3", messageIdFrom: "s3:0", messageIdTo: "s3:0" },
  complete: async () => "I found nothing",
});
check("an unreadable answer is not 'there was nothing'", !unreadable.ok);
const [episodes] = await client`SELECT count(*)::int AS n FROM ${client.unsafe(`${SCHEMA}.episodes`)}`;
check("and leaves no orphan episode", episodes!.n === 2, `${episodes!.n} episodes`);

const empty = await memory.ingestConversation({
  tenantId: A,
  agent: "assistant",
  turns: [],
  source: { kind: "conversation", sessionId: "s4", messageIdFrom: "s4:0", messageIdTo: "s4:0" },
  complete,
});
check("with no turns there is nothing to extract", empty.ok && empty.facts === 0);

// ─── Already-stated facts (what the agent did) ───────────────────────────────

const fromActions = await memory.ingestFacts({
  tenantId: A,
  agent: "assistant",
  facts: [{ sourceName: "the agent", targetName: "Moving", fact: "the agent created Moving", validAt: new Date() }],
  source: { kind: "action", sessionId: "s1", messageId: "s1:2" },
  content: 'create_page:{"title":"Moving"}:true',
  validAt: new Date(),
  complete,
});
check("facts stated by the client get in", fromActions === 1);
check("with no facts nothing is written", (await memory.ingestFacts({
  tenantId: A, agent: "assistant", facts: [],
  source: { kind: "action", sessionId: "s1", messageId: "s1:3" },
  content: "", validAt: new Date(), complete,
})) === 0);

// ─── Notes, documents ────────────────────────────────────────────────────────

await memory.remember({ tenantId: A, agent: "assistant", note: "They like short answers", sessionId: "s1" });
await memory.remember({ tenantId: A, agent: "other", note: "Another agent's note", sessionId: "s9" });

const indexed = await memory.indexDocuments(A, [
  { externalId: "p1", title: "Moving", toc: "## Boxes\n## Truck", extra: { views: [{ name: "All", viewId: "v1" }] } },
  { externalId: "p2", title: "Recipes", extra: { properties: { status: "Active" } } },
]);
check("documents get indexed", indexed === 2);
const [withVector] = await client`
  SELECT count(*)::int AS n FROM ${client.unsafe(`${SCHEMA}.document_index`)}
  WHERE tenant_id = ${A} AND embedding IS NOT NULL AND embedding_model = ${stub.name}`;
check("with their vector, computed by the memory", withVector!.n === 2);

await memory.indexDocuments(A, [{ externalId: "p1", title: "Moving to Cordoba", toc: "## Boxes" }]);
const list = await memory.documents(A);
check("indexing again overwrites, does not duplicate", list.length === 2 && list.some((d) => d.title === "Moving to Cordoba"));
check("extra comes back as it was stored",
  (list.find((d) => d.externalId === "p2")!.extra.properties as Record<string, string>).status === "Active");

// ─── Recall ──────────────────────────────────────────────────────────────────

embeddedCount.set(A, 0);
const recalled = await memory.recall(A, "assistant", "Rosario", { facts: 5, notes: 5, documents: 5, diversity: 0.7 });
check("recall embeds the query only once", embeddedCount.get(A) === 1, `${embeddedCount.get(A)} times`);
check("it finds the facts by text", recalled.facts.some((f) => f.fact === "The user lives in Rosario"));
check("and the agent's notes", recalled.notes.some((n) => n.note === "They like short answers"));
check("never another agent's", recalled.notes.every((n) => n.agent === "assistant"));
check("and documents", recalled.documents.length > 0);

const noDocuments = await memory.recall(A, "assistant", "Rosario", { documents: 0 });
check("with documents at zero it does not search them", noDocuments.documents.length === 0);

const blank = await memory.recall(A, "assistant", "", { facts: 10, notes: 5 });
check("with empty text, the most recent", blank.facts.length === 3 && blank.notes.length === 1,
  `${blank.facts.length} facts, ${blank.notes.length} notes`);

const otherAgent = await memory.recall(A, "other", "Rosario");
check("facts belong to the agent that heard them", otherAgent.facts.length === 0);

// ─── Isolation ───────────────────────────────────────────────────────────────

const fromB = await memory.recall(B, "assistant", "Rosario");
check("another tenant sees nothing", fromB.facts.length === 0 && fromB.notes.length === 0 && fromB.documents.length === 0);
check("not even documents", (await memory.documents(B)).length === 0);

const sources = await memory.episodes(A, recalled.facts.flatMap((f) => f.episodeIds));
check("episodes can be followed back to their source", sources.some((e) => e.source.kind === "conversation"));
check("and one tenant cannot read another's episodes", (await memory.episodes(B, sources.map((e) => e.id))).length === 0);

// ─── Contradiction ───────────────────────────────────────────────────────────

const moved = await memory.ingestConversation({
  tenantId: A,
  agent: "assistant",
  turns: [{ role: "user", text: "I moved, I live in Cordoba now" }],
  source: { kind: "conversation", sessionId: "s5", messageIdFrom: "s5:0", messageIdTo: "s5:0" },
  complete: async (prompt) =>
    prompt.startsWith("You extract")
      ? JSON.stringify([{ source: "user", target: "Rosario", fact: "The user moved out of Rosario", since: null }])
      : "[1]",
});
check("a contradicting fact gets in", moved.ok && moved.facts === 1);
const valid = await memory.recall(A, "assistant", "Rosario");
check("and the old one stops being valid", !valid.facts.some((f) => f.fact === "The user lives in Rosario"));
check("logging it", logged.includes("fact invalidated by contradiction"));

// ─── Model change ────────────────────────────────────────────────────────────

check("with the same model there is nothing to recompute", (await memory.tenantsToReembed(stub.name)).length === 0);
const pending = await memory.tenantsToReembed("other/model");
check("with another one, the tenant shows up", pending.length === 1 && pending[0] === A);

await client.end();
