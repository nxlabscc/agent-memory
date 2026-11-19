/**
 * The memory, opened up: what a client uses without knowing how things are stored.
 *
 * The client decides WHEN —when a chat closes, after thirty seconds of
 * silence, once it has walked through its documents— and hands over what it
 * has. Everything after that happens here: the episode, the extraction, the
 * entities, the vector, the repetition, the contradiction, the write. Recall
 * works the same way: the client asks with text and the memory decides how to
 * search.
 *
 * The lower-level pieces (`createMemoryStore`, `createMemorySearch`, …) are
 * still exported for anyone who wants to assemble a different path. This is
 * the assembled one.
 *
 * What gets stored is the client's call: the memory does not interpret tools
 * or know anyone's format. It receives a conversation, or already-stated
 * facts, or a note, or a document, and stores them.
 */

import { createHash, randomUUID } from "node:crypto";
import { judgeContradictions } from "./contradiction";
import { findRepeatedFact, normalizeExact, resolveEntities } from "./dedup";
import { createDocumentIndex, documentEmbeddingText } from "./documents";
import type { IndexedDocument, NewDocument } from "./documents";
import type { FactDraft } from "./drafts";
import type { EmbeddingProvider } from "./embedding";
import { extractFacts } from "./extract";
import { forgetSessions, type ForgetOptions, type Forgotten } from "./forget";
import type { CompleteFn, ConversationTurn, PromptOptions } from "./extract";
import { applyInvalidation, resolveContradictions } from "./invalidation";
import { applyMigrations, type MigratingSql } from "./migrations";
import { createAgentNotes, type AgentNote } from "./notes";
import { reembedTenant, tenantsWithStaleEmbeddings } from "./reembed";
import type { ReembedOptions, ReembedReport } from "./reembed";
import { cosineSimilarity, maximalMarginalRelevance } from "./rerank";
import { createMemorySearch } from "./search";
import { createMemoryStore, DEFAULT_SCHEMA, requireSchema } from "./store";
import type { Episode, EpisodeSource, Fact, TenantId } from "./types";

/**
 * Swarm contradiction: how a new fact finds what it might contradict.
 *
 * `SWARM_CANDIDATE_LIMIT` caps how many of the tenant's valid facts, nearest by
 * the fact's own vector, reach the judge — it bounds the judge's cost.
 * `CONTRADICTION_CANDIDATE_COSINE_MIN` is how close a fact must be to reach it
 * at all. It sits below the repetition cutoff (`SAME_FACT_COSINE_MIN`, 0.92) on
 * purpose: the aim is to SHOW the judge what might conflict, not to decide
 * equivalence, so it leans to recall and the LLM judge is the precision filter.
 * It is a starting point, not a number measured against a benchmark.
 */
const SWARM_CANDIDATE_LIMIT = 12;
const CONTRADICTION_CANDIDATE_COSINE_MIN = 0.5;

export interface MemoryConfig {
  /** The Postgres client. The memory opens no connections of its own: it uses this one. */
  sql: MigratingSql;
  /** Which schema it lives in. Created if it does not exist. */
  schema?: string;
  /**
   * Who embeds each tenant's content, or `null` if there is no provider: then
   * everything is stored without a vector and search falls back to text.
   *
   * It is per tenant so that who pays for each vector is known at the moment
   * it is requested.
   */
  embedder: (tenantId: TenantId) => EmbeddingProvider | null;
  /** Internal events worth reporting: a migration applied, a fact invalidated. */
  log?: (message: string, data: Record<string, unknown>) => void;
  /**
   * Whose facts a new one is weighed against for contradiction.
   *
   * - `"agent"` (the default): each agent's memory is its own. A new fact is
   *   weighed only against the same agent's facts about the same pair of
   *   entities. Independent viewpoints that never collide — the shape for
   *   agents that are different people's assistants.
   * - `"swarm"`: the agents are one team over a shared reality (a codebase, a
   *   project). A new fact is weighed against the whole tenant's currently
   *   valid facts — the same pair of entities across every agent, and the ones
   *   nearest by meaning — so a later team fact can close an earlier one of
   *   another agent, even when phrased with other words. The closed fact keeps
   *   its author; only its validity changes. Repetition stays per agent:
   *   provenance is still whoever said it.
   */
  isolation?: "agent" | "swarm";
}

/** A fact already stated by the client, without provenance: the memory supplies the episode. */
export type StatedFact = Omit<FactDraft, "episodeId">;

export interface ConversationInput extends PromptOptions {
  tenantId: TenantId;
  /** Who owns what gets remembered: only that agent will see it. */
  agent: string;
  /** The new turns, the ones not delivered yet. */
  turns: ConversationTurn[];
  /** Where the original text lives. The episode is a pointer, not a copy. */
  source: EpisodeSource;
  /** The model used to extract and to judge contradictions. Supplied by the caller. */
  complete: CompleteFn;
  /** When it was said. It becomes the `valid_at` of whatever is extracted. */
  now?: Date;
}

/**
 * How ingesting a conversation went.
 *
 * `ok: false` means the model answered something unreadable, which is not the
 * same as "there was nothing": the caller should not mark that stretch as
 * processed.
 */
export type IngestOutcome =
  | { ok: true; facts: number }
  | { ok: false; reason: string; raw: string };

export interface FactsInput {
  tenantId: TenantId;
  agent: string;
  facts: StatedFact[];
  source: EpisodeSource;
  /** The text `source` points to, for the hash that makes the citation verifiable. */
  content: string;
  /** When it happened. It becomes the episode's `valid_at`. */
  validAt: Date;
  /** The model used to judge contradictions against what is already known. */
  complete: CompleteFn;
}

export interface NoteInput {
  tenantId: TenantId;
  agent: string;
  note: string;
  sessionId?: string | null;
}

export interface RecallOptions {
  /** How many facts. */
  facts?: number;
  /** How many notes. */
  notes?: number;
  /** How many documents. Zero skips the search. */
  documents?: number;
  /**
   * How much relevance weighs against variety when picking facts (MMR).
   * Without it, the top results of the fusion are taken.
   */
  diversity?: number;
  /** Only facts valid at this point in world time. */
  at?: Date;
}

export interface Recalled {
  facts: Fact[];
  notes: AgentNote[];
  documents: IndexedDocument[];
}

export interface Memory {
  readonly schema: string;

  /** A conversation goes in, facts come out. */
  ingestConversation(input: ConversationInput): Promise<IngestOutcome>;
  /** Facts the client can already state —what an agent did— go in with their episode. */
  ingestFacts(input: FactsInput): Promise<number>;
  /** What the agent decided to write down, in its own words. */
  remember(input: NoteInput): Promise<void>;
  /** Writes or overwrites documents in the index. Returns how many. */
  indexDocuments(tenantId: TenantId, docs: NewDocument[]): Promise<number>;
  forgetDocuments(tenantId: TenantId, externalIds: string[]): Promise<void>;
  /**
   * The client deleted these sessions: their notes and episodes go, and so do
   * the facts that came only from them and the entities left without facts.
   */
  forgetSessions(tenantId: TenantId, sessionIds: string[], options?: ForgetOptions): Promise<Forgotten>;

  /**
   * What is relevant to a text: the agent's facts and notes, the tenant's
   * documents. With empty text there is no ranking: the most recent.
   */
  recall(tenantId: TenantId, agent: string, query: string, options?: RecallOptions): Promise<Recalled>;
  /** The tenant's whole document index, by title. */
  documents(tenantId: TenantId): Promise<IndexedDocument[]>;
  /** The episodes, to follow the pointer back to the original text. */
  episodes(tenantId: TenantId, ids: string[]): Promise<Episode[]>;

  /** Tenants with something embedded by a model other than `model`. */
  tenantsToReembed(model: string): Promise<string[]>;
  /** Moves the tenant's content to the current model. `null` if there is no provider. */
  reembed(tenantId: TenantId, options?: Omit<ReembedOptions, "schema">): Promise<ReembedReport | null>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Opens the memory: creates the schema if it does not exist, applies any
 * pending migrations and returns the instance.
 */
export async function createMemory(config: MemoryConfig): Promise<Memory> {
  const schema = requireSchema(config.schema ?? DEFAULT_SCHEMA);
  const { sql, embedder } = config;
  const log = config.log ?? (() => {});
  const isolation = config.isolation ?? "agent";

  for (const name of await applyMigrations(sql, schema)) {
    log("migration applied", { schema, name });
  }

  const store = createMemoryStore(sql, schema);
  const search = createMemorySearch(sql, schema);
  const notes = createAgentNotes(sql, schema);
  const index = createDocumentIndex(sql, schema);

  /**
   * The facts a new one is weighed against for contradiction.
   *
   * In isolation it is what the same agent already holds about this very pair
   * of entities — the library's original partition. In a swarm the agents are
   * one team over a shared reality, so the set widens to the whole tenant: the
   * same pair of entities across every agent (a later fact can close an earlier
   * one of another agent), and, when there is a vector, the facts nearest by
   * meaning — which is how "a CLI entry point" reaches "a console entry point"
   * though the words and the entities differ. The judge decides which exclude
   * each other; this decides only what the judge gets to see.
   */
  async function contradictionCandidates(
    tenantId: TenantId,
    draft: FactDraft,
    sourceEntityId: string,
    targetEntityId: string,
    sameAgent: Fact[],
    embedding: number[] | undefined,
    embeddingModel: string | undefined,
  ): Promise<Fact[]> {
    if (isolation === "agent") return sameAgent;

    const byId = new Map<string, Fact>();
    for (const f of await store.factsBetweenAcrossAgents(
      tenantId,
      sourceEntityId,
      targetEntityId,
      draft.validAt,
    )) {
      byId.set(f.id, f);
    }
    if (embedding && embeddingModel) {
      const near = await search.factsByVectorAcrossAgents(tenantId, embedding, embeddingModel, {
        at: draft.validAt,
        limit: SWARM_CANDIDATE_LIMIT,
      });
      for (const f of near) {
        if (
          f.embedding != null &&
          cosineSimilarity(f.embedding, embedding) >= CONTRADICTION_CANDIDATE_COSINE_MIN
        ) {
          byId.set(f.id, f);
        }
      }
    }
    return [...byId.values()];
  }

  /**
   * Resolves the candidates' entities and writes.
   *
   * A name the deterministic resolver cannot place is a new entity. The other
   * half —having the LLM break ties on ambiguous names— is separate work;
   * until it exists, not placing a name means creating it.
   *
   * Entities belong to the tenant, not the agent: that something exists is
   * known to everyone, and two agents talking about the same thing point to
   * the same entity. Facts do belong to the agent, which is why repetition and
   * contradiction are only looked for among its own.
   */
  async function persistDrafts(
    tenantId: TenantId,
    agent: string,
    drafts: FactDraft[],
    complete: CompleteFn,
  ): Promise<number> {
    if (drafts.length === 0) return 0;

    const names = [...new Set(drafts.flatMap((d) => [d.sourceName, d.targetName]))];
    const existing = await store.candidateEntities(tenantId);
    const { resolutions } = resolveEntities(names, existing);

    const idByName = new Map<string, string>();
    for (const resolution of resolutions) {
      if (resolution.match !== null) {
        idByName.set(resolution.name, resolution.match.id);
        continue;
      }
      const id = randomUUID();
      await store.insertEntity(tenantId, {
        id,
        name: resolution.name,
        // The same normalization the resolver used when it failed to find it:
        // if it differed here, the new entity would be unreachable that way.
        normalizedName: normalizeExact(resolution.name),
      });
      idByName.set(resolution.name, id);
    }

    let written = 0;
    for (const draft of drafts) {
      const sourceEntityId = idByName.get(draft.sourceName);
      const targetEntityId = idByName.get(draft.targetName);
      if (sourceEntityId === undefined || targetEntityId === undefined) continue;

      // Saying something again is not learning something new. If there is
      // already a current fact between the same two entities that says the
      // same thing, the episode is added to its provenance instead of opening
      // another row: it was repeated, and that is recorded in the sources, not
      // in the number of facts.
      const current = await store.factsBetween(
        tenantId,
        agent,
        sourceEntityId,
        targetEntityId,
        draft.validAt,
      );

      // The vector is computed before deciding: it is what reveals that two
      // different statements say the same thing, which is most of what gets
      // repeated across conversations.
      const provider = embedder(tenantId);
      const embedding = provider === null ? undefined : await provider.embed(draft.fact);
      const repeated = findRepeatedFact(draft.fact, current, embedding);
      if (repeated !== null) {
        await store.linkEpisode(tenantId, repeated.id, draft.episodeId);
        continue;
      }

      // Who this new fact is weighed against for contradiction, gathered before
      // the write so the fact is never offered as its own candidate. In
      // isolation that is the agent's own facts about this pair; in a swarm it
      // is the whole tenant's, by pair and by meaning.
      const candidates = await contradictionCandidates(
        tenantId,
        draft,
        sourceEntityId,
        targetEntityId,
        current,
        embedding,
        provider?.name,
      );

      const created = {
        id: randomUUID(),
        agent,
        sourceEntityId,
        targetEntityId,
        fact: draft.fact,
        validAt: draft.validAt,
        episodeIds: [draft.episodeId],
        ...(embedding ? { embedding, embeddingModel: provider!.name } : {}),
      };
      await store.insertFact(tenantId, created);
      written++;

      // What is left after ruling out repetition: different statements that may
      // coexist or exclude each other. Comparing text cannot decide that — it
      // is the part left to the LLM, over the candidates gathered above.
      if (candidates.length === 0) continue;
      const contradicted = await judgeContradictions(
        complete,
        draft.fact,
        candidates.map((f) => f.fact),
      );
      if (contradicted.length === 0) continue;

      // The model says WHICH ones exclude each other; which interval closes
      // which is decided by comparing dates, without a model. A fact is never
      // deleted.
      const incoming: Fact = {
        ...created, tenantId, invalidAt: null, createdAt: new Date(), expiredAt: null,
      };
      for (const invalidation of resolveContradictions(
        incoming,
        contradicted.map((i) => candidates[i]!),
      )) {
        const closed = applyInvalidation(invalidation, new Date());
        await store.invalidateFact(tenantId, closed.id, closed.invalidAt!, closed.expiredAt!);
        log("fact invalidated by contradiction", {
          fact: closed.fact,
          replaced_by: draft.fact,
        });
      }
    }
    return written;
  }

  return {
    schema,

    async ingestConversation(input) {
      if (input.turns.length === 0) return { ok: true, facts: 0 };
      const now = input.now ?? new Date();
      const episodeId = randomUUID();

      const outcome = await extractFacts(input.complete, {
        turns: input.turns,
        episodeId,
        now,
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.today !== undefined ? { today: input.today } : {}),
      });
      if (!outcome.ok) return outcome;

      // The episode is written only now: if it were written earlier, every
      // retry after an unreadable response would leave an orphan episode.
      await store.insertEpisode(input.tenantId, {
        id: episodeId,
        source: input.source,
        // The hash is what makes it verifiable that the original still says
        // what it said when it was remembered.
        contentSha256: sha256(input.turns.map((t) => `${t.role}: ${t.text}`).join("\n")),
        validAt: now,
      });

      const facts = await persistDrafts(input.tenantId, input.agent, outcome.drafts, input.complete);
      return { ok: true, facts };
    },

    async ingestFacts(input) {
      if (input.facts.length === 0) return 0;
      const episodeId = randomUUID();
      await store.insertEpisode(input.tenantId, {
        id: episodeId,
        source: input.source,
        contentSha256: sha256(input.content),
        validAt: input.validAt,
      });
      return persistDrafts(
        input.tenantId,
        input.agent,
        input.facts.map((f) => ({ ...f, episodeId })),
        input.complete,
      );
    },

    async remember(input) {
      const provider = embedder(input.tenantId);
      const embedding = provider === null ? undefined : await provider.embed(input.note);
      await notes.write(input.tenantId, {
        id: randomUUID(),
        note: input.note,
        agent: input.agent,
        sessionId: input.sessionId ?? null,
        ...(embedding ? { embedding, embeddingModel: provider!.name } : {}),
      });
    },

    async indexDocuments(tenantId, docs) {
      if (docs.length === 0) return 0;
      const provider = embedder(tenantId);
      // All of them in a single call to the provider.
      const vectors = provider === null
        ? null
        : await provider.embedBatch(docs.map((d) => documentEmbeddingText(d.title, d.toc ?? "")));
      for (const [i, doc] of docs.entries()) {
        await index.upsert(tenantId, {
          ...doc,
          id: randomUUID(),
          ...(vectors ? { embedding: vectors[i], embeddingModel: provider!.name } : {}),
        });
      }
      return docs.length;
    },

    forgetDocuments(tenantId, externalIds) {
      return index.forget(tenantId, externalIds);
    },

    forgetSessions(tenantId, sessionIds, options) {
      return forgetSessions(sql, schema, tenantId, sessionIds, options);
    },

    async recall(tenantId, agent, query, options = {}) {
      const at = options.at ?? new Date();
      const maxFacts = options.facts ?? 10;
      const maxNotes = options.notes ?? 5;
      const maxDocuments = options.documents ?? 5;

      // With nothing to search for —a session that starts empty— the most
      // recent is better than nothing.
      if (query.trim().length === 0) {
        return {
          facts: (await store.factsValidAt(tenantId, agent, at)).slice(-maxFacts),
          notes: maxNotes > 0 ? await notes.recent(tenantId, agent, maxNotes) : [],
          documents: [],
        };
      }

      // Once, for all three searches: facts, notes and documents are searched
      // with the SAME text, so embedding it three times would be three trips
      // to the provider —and three charges— for the same vector.
      const provider = embedder(tenantId);
      const embedding = provider === null ? undefined : await provider.embed(query);
      const model = provider?.name;

      const found = await search.hybrid(
        tenantId,
        agent,
        // The vector travels with the model that produced it: cosine search
        // against another model's vectors returns a meaningless ranking.
        { text: query, ...(embedding && model ? { embedding, model } : {}) },
        { at, limit: options.diversity === undefined ? maxFacts : maxFacts * 2 },
      );

      let facts = found.slice(0, maxFacts);
      // With variety: without this, a question about the editor takes every
      // fact about the editor and none about anything else.
      if (options.diversity !== undefined && embedding !== undefined) {
        const withVector = found.filter((f) => Array.isArray(f.embedding));
        const withoutVector = found.filter((f) => !Array.isArray(f.embedding));
        const diverse = maximalMarginalRelevance(
          withVector.map((fact) => ({ ...fact, embedding: fact.embedding! })),
          embedding,
          options.diversity,
          maxFacts,
        );
        facts = [...diverse, ...withoutVector].slice(0, maxFacts);
      }

      const recalledNotes = maxNotes === 0
        ? []
        : embedding && model
          ? await notes.byVector(tenantId, agent, embedding, model, maxNotes)
          : await notes.byText(tenantId, agent, query, maxNotes);

      const recalledDocuments = maxDocuments === 0
        ? []
        : embedding && model
          ? await index.byVector(tenantId, embedding, model, maxDocuments)
          : await index.byText(tenantId, query, maxDocuments);

      return { facts, notes: recalledNotes, documents: recalledDocuments };
    },

    documents(tenantId) {
      return index.list(tenantId);
    },

    episodes(tenantId, ids) {
      return store.getEpisodes(tenantId, ids);
    },

    tenantsToReembed(model) {
      return tenantsWithStaleEmbeddings(sql, model, schema);
    },

    async reembed(tenantId, options = {}) {
      const provider = embedder(tenantId);
      if (provider === null) return null;
      return reembedTenant(sql, tenantId, provider, { ...options, schema });
    },
  };
}
