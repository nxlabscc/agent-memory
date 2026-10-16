# @nxlabs/agent-memory

Long-term memory for agents, on Postgres + pgvector, for Bun, in TypeScript source.

You hand it conversations, facts, notes and documents; it gives back what is relevant to a text.
The client decides what to hand over and when; how it is stored and searched is the library's.

- **Facts** are edges between two **entities**, with validity on two time axes: when the system
  learned it (`created_at` / `expired_at`) and when it was true in the world (`valid_at` /
  `invalid_at`). Nothing is deleted: a fact that stops being true closes its interval.
- Every fact keeps its **provenance**: the episodes it came from. An episode is a pointer to the
  original text plus its hash, never a copy.
- Writing resolves entities deterministically (exact name, then MinHash + Jaccard), merges a repeated
  fact into the existing one (by vector, or text when there is none), and lets the LLM judge
  contradictions while the code decides which interval closes.
- Reading is hybrid: full-text and vector, fused with RRF, optionally diversified with MMR.
- Facts and notes belong to an **agent**; entities and documents belong to the **tenant**. Every
  query is scoped by tenant, and a guard rejects any SQL statement that does not mention `tenant_id`.

## Install

```json
"dependencies": {
  "@nxlabs/agent-memory": "github:nxlabscc/agent-memory#v0.1.0"
}
```

Bun runs the `.ts` files as they are; there is no build step. The database needs the `vector`
extension.

## Use

```ts
import postgres from "postgres";
import { createMemory, type MigratingSql } from "@nxlabs/agent-memory";

const sql = postgres(process.env.DATABASE_URL!) as unknown as MigratingSql;

// Creates the schema if it does not exist and applies pending migrations.
const memory = await createMemory({
  sql,
  schema: "memory",                       // optional, "memory" by default
  embedder: (tenantId) => myProvider,     // an EmbeddingProvider, or null: then text search only
  log: (message, data) => console.log(message, data),
});

// A conversation goes in; the LLM call is yours (your model, your key).
await memory.ingestConversation({
  tenantId,
  agent: "assistant",
  turns: [{ role: "user", text: "I live in Rosario and I prefer TypeScript" }],
  source: { kind: "conversation", sessionId, messageIdFrom, messageIdTo },
  complete: (prompt) => callYourModel(prompt),
});

// What is relevant to a text: facts, notes and documents.
const { facts, notes, documents } = await memory.recall(tenantId, "assistant", "where do they live?", {
  facts: 10, notes: 5, documents: 5, diversity: 0.7,
});
```

### Writing

| | receives | does |
|---|---|---|
| `ingestConversation` | new turns, the pointer to their source, the model to extract with | extraction, episode, entities, vectors, repeats, contradictions |
| `ingestFacts` | facts the client already states (e.g. what an agent did), the pointer and the text it points to | episode, and the same from entities on |
| `remember` | an agent's note | vector and write |
| `indexDocuments` / `forgetDocuments` | documents: external id, title, table of contents, free-form `extra` | vector of title + toc, upsert; `extra` is stored and returned untouched |

### Reading

| | returns |
|---|---|
| `recall(tenantId, agent, text, { facts?, notes?, documents?, diversity?, at? })` | `{ facts, notes, documents }`; the numbers are how many of each, `at` the instant facts must be valid at |
| `documents(tenantId)` | the whole document index, by title |
| `episodes(tenantId, ids)` | episodes, to follow a fact back to its source |

Rendering any of this into a prompt is the client's.

### Embeddings

The library knows no provider. It defines `EmbeddingProvider` and the vector length
(`EMBEDDING_DIMENSIONS`, 768, the size of its columns), and receives a function from tenant to
provider when opened. `tenantsToReembed` and `reembed` move what was embedded with another model to
the current one.

The lower-level pieces (`createMemoryStore`, `createMemorySearch`, `createAgentNotes`,
`createDocumentIndex`, extraction, dedup, rerank) are exported too, all taking the schema.

## Tests

- **`src/**/*.test.ts`** — unit tests, next to the code. They use a fake database client.
- **`test/doubles/`** — `createStubEmbedder` and `createFixtureEmbedder`: `EmbeddingProvider`s for
  tests, with no network and no key.
- **`test/fixtures/`** — precomputed real vectors and the calibration corpus.
- **`test/integration/`** — against a real Postgres with pgvector.

```sh
bun run typecheck
bun run test                      # unit tests and doubles

docker run -d --rm --name mem-pg -p 5432:5432 -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t pgvector/pgvector:pg16
MEMORY_DATABASE_URL="postgres://postgres:x@localhost:5432/t" bun run test:integration
docker stop mem-pg
```

Integration tests fail without `MEMORY_DATABASE_URL`; they are not skipped.

## License

Apache-2.0
