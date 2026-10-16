/**
 * `EmbeddingProvider` doubles for tests: no network, no key, no cost.
 *
 * They are not part of the library. The library's own tests use them, and so
 * can a client's test stacks (acceptance and system tests) that run the memory
 * without a real embedding API.
 */

import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "../../src/embedding";

/** FNV-1a, 32 bits. Same hash the deduplication uses. */
function hash(text: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * A provider backed by the committed fixture: the real vectors, no network.
 *
 * Texts in the fixture get the embedding the real model produced for them, so
 * a test can assert that two paraphrases collapse into one fact and mean it —
 * the geometry is the model's, not something we invented.
 *
 * A text that is not in the fixture gets a hash of itself. That keeps the
 * acceptance stack running (every fact it extracts needs some vector) without
 * pretending to know what those texts mean: their distances are noise, and a
 * test that leans on them is testing this function.
 */
export function createFixtureEmbedder(
  table: Record<string, number[]>,
  dimensions: number = EMBEDDING_DIMENSIONS,
): EmbeddingProvider {
  return {
    dimensions,
    name: `fixture/gemini-embedding-2-${dimensions}`,
    async embed(text: string): Promise<number[]> {
      const known = table[text];
      if (known !== undefined && known.length === dimensions) return known;
      return normalize(hashedVector(text, dimensions));
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((text) => this.embed(text)));
    },
  };
}

/**
 * A provider for tests: no network, no key, no cost.
 *
 * The vectors are derived from the text, so the same text always embeds the
 * same and different texts do not collide. They carry no meaning — "cat" is no
 * closer to "kitten" than to "hydraulics" — which is the point: a test that
 * depends on real semantics is testing the model, not our code.
 *
 * Unit length, because everything downstream compares by cosine and a vector
 * with the wrong magnitude fails in a way that is hard to see.
 */
export function createStubEmbedder(
  dimensions: number = EMBEDDING_DIMENSIONS,
): EmbeddingProvider {
  return {
    dimensions,
    name: `stub/deterministic-${dimensions}`,
    async embed(text: string): Promise<number[]> {
      return normalize(hashedVector(text, dimensions));
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((text) => this.embed(text)));
    },
  };
}

function hashedVector(text: string, dimensions: number): number[] {
  // Centered on zero: otherwise every vector points into the same orthant and
  // any pair comes out with a very high similarity.
  return Array.from({ length: dimensions }, (_, i) => hash(text, i) / 0xffffffff - 0.5);
}

/** Everything downstream compares by cosine: a wrong magnitude fails silently. */
function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, x) => acc + x * x, 0));
  return norm === 0 ? vector : vector.map((x) => x / norm);
}
