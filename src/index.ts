export type {
  TenantId,
  EpisodeSource,
  Episode,
  Entity,
  Fact,
} from "./types";

export { isValidAt } from "./types";

export type { FactDraft } from "./drafts";

/** The opened-up memory: the assembled path, from handing over to recalling. */
export type {
  ConversationInput,
  FactsInput,
  IngestOutcome,
  Memory,
  MemoryConfig,
  NoteInput,
  Recalled,
  RecallOptions,
  StatedFact,
} from "./memory";

export { createMemory } from "./memory";

export type {
  CandidateIndex,
  Resolution,
  ResolutionResult,
  ResolutionVia,
} from "./dedup";

export {
  buildCandidateIndex,
  findRepeatedFact,
  sameFactText,
  normalizeExact,
  normalizeFuzzy,
  resolveEntities,
  resolveName,
} from "./dedup";

export type {
  CompleteFn,
  ConversationTurn,
  ExtractionOutcome,
  ExtractionRequest,
  PromptOptions,
} from "./extract";

export { extractFacts, extractionPrompt, parseExtraction } from "./extract";

export {
  contradictionPrompt,
  judgeContradictions,
  parseContradiction,
} from "./contradiction";

export type { Invalidation } from "./invalidation";

export { applyInvalidation, resolveContradictions } from "./invalidation";

export type { Embedded, Ranked } from "./rerank";

export {
  cosineSimilarity,
  maximalMarginalRelevance,
  reciprocalRankFusion,
} from "./rerank";



export type { EmbeddingProvider } from "./embedding";



export { EMBEDDING_DIMENSIONS } from "./embedding";

export type { AgentNote, AgentNotes, NewNote } from "./notes";

export { createAgentNotes } from "./notes";

export type {
  DocumentIndex,
  DocumentRecord,
  IndexedDocument,
  NewDocument,
} from "./documents";

export { createDocumentIndex, documentEmbeddingText } from "./documents";

export type { MigratingSql, Migration } from "./migrations";

export { applyMigrations, migrations } from "./migrations";

export type {
  MemoryStore,
  NewEntity,
  NewEpisode,
  NewFact,
  Sql,
} from "./store";

export {
  AgentRequiredError,
  createMemoryStore,
  guard,
  requireAgent,
  requireTenant,
  TenantRequiredError,
  UnscopedQueryError,
} from "./store";

export type {
  HybridQuery,
  MemorySearch,
  SearchOptions,
  TraversalOptions,
} from "./search";

export { createMemorySearch } from "./search";

/** Recomputing the vectors when the embedding model changes. */
export type { ReembedOptions, ReembedReport } from "./reembed";
export { reembedTenant, tenantsWithStaleEmbeddings } from "./reembed";
