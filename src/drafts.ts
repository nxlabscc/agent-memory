/**
 * Candidate fact: what extraction produces before entities are resolved.
 *
 * Both fact producers —LLM extraction from prose and deterministic mapping of
 * actions— emit this same shape. Only afterwards does it go through entity
 * resolution (`dedup.ts`), where it becomes a `Fact`.
 *
 * That is why entities are referenced by **name** rather than by id: at this
 * point we do not know yet whether they exist.
 */
export interface FactDraft {
  sourceName: string;
  targetName: string;
  /** The statement as text. It is what will be embedded and rendered. */
  fact: string;
  /** When it became true (world time). */
  validAt: Date;
  /** The episode it came from. Provenance. */
  episodeId: string;
}
