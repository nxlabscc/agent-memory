/**
 * Turning text into a vector.
 *
 * The interface is the contract between the memory and whatever model does the
 * arithmetic. Computing an embedding and storing one are separate concerns:
 * this module does not know about Postgres, and the store does not know which
 * model produced what it holds.
 *
 * There is deliberately no automatic fallback. A provider that quietly returns
 * zero vectors when it is not configured looks exactly like a working one from
 * the outside, and the failure only surfaces as bad search results months
 * later. Whoever wires this decides what to do when there is no provider.
 */

/** How many dimensions we ask for, and what the column holds. */
export const EMBEDDING_DIMENSIONS = 768;

export interface EmbeddingProvider {
  /** One text, one vector of `dimensions` numbers. */
  embed(text: string): Promise<number[]>;
  /** A batch in a single call. Same order as the input. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /**
   * The length of every vector this provider returns.
   *
   * Not a property of the model: both Gemini and OpenAI take the size as a
   * request parameter, so it is our choice and it is the same across providers
   * (768 — see the migration, and the test that keeps the two in step).
   */
  readonly dimensions: number;
  /**
   * Who produced the vector, as `<provider>/<model>`. Stored next to each
   * embedding: two providers' vectors are not comparable even at the same
   * length, so switching means knowing which ones to recompute.
   */
  readonly name: string;
}
