/**
 * Pure rerankers.
 *
 * Search methods aim for recall; reranking aims for precision. This module
 * holds the rerankers that never query the store: ranking fusion and
 * diversification. The ones that do —mention frequency, distance to a
 * centroid— live elsewhere.
 */

/** A ranked result. `id` is all the reranker needs in order to fuse. */
export interface Ranked {
  id: string;
}

/**
 * Reciprocal Rank Fusion.
 *
 * Combines several rankings without requiring their scores to be comparable
 * with each other — which is exactly the problem with mixing cosine, BM25 and
 * traversal. Each list contributes `1 / (k + position)`, so what counts is the
 * place, not the score.
 *
 * `k` dampens the top positions: with a small k the first place dominates;
 * with a large k, appearing in several lists is worth more than coming first
 * in one. 60 is the value from the original paper and works well as a default.
 */
export function reciprocalRankFusion<T extends Ranked>(
  rankings: T[][],
  k = 60,
): T[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, T>();

  for (const ranking of rankings) {
    ranking.forEach((item, position) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + position + 1));
      if (!byId.has(item.id)) byId.set(item.id, item);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id)!);
}

/** A result with its vector, for diversification. */
export interface Embedded extends Ranked {
  embedding: number[];
}

/** Cosine similarity. Vectors of different length give 0. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Maximal Marginal Relevance.
 *
 * Picks one at a time, balancing how relevant each candidate is to the query
 * against how similar it is to what has already been picked. It keeps the
 * context from filling up with five ways of saying the same fact.
 *
 * `lambda` is the balance: 1 is pure relevance (equivalent to not
 * diversifying), 0 is pure diversity. Below ~0.5 it starts bringing in barely
 * relevant results.
 */
export function maximalMarginalRelevance<T extends Embedded>(
  candidates: T[],
  queryEmbedding: number[],
  lambda = 0.7,
  limit = candidates.length,
): T[] {
  const remaining = [...candidates];
  const selected: T[] = [];

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const relevance = cosineSimilarity(candidate.embedding, queryEmbedding);

      let maxSimilarity = 0;
      for (const chosen of selected) {
        const similarity = cosineSimilarity(
          candidate.embedding,
          chosen.embedding,
        );
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }

      const score = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    selected.push(remaining[bestIndex]!);
    remaining.splice(bestIndex, 1);
  }

  return selected;
}
