/**
 * Invalidation by contradiction.
 *
 * **Uses no LLM.** The model produces the semantically related candidates;
 * which interval closes which is decided by comparing dates.
 *
 * A fact is never deleted. When it stops being true its interval is closed,
 * so it remains possible to answer "what did you know on August 5th?".
 */

import type { Fact } from "./types";

/** An existing fact whose interval the new fact closes. */
export interface Invalidation {
  fact: Fact;
  /** When it stops holding: the `validAt` of the fact that contradicts it. */
  invalidAt: Date;
}

/** Two intervals overlap if each one starts before the other ends. */
function overlaps(
  aFrom: Date | null,
  aTo: Date | null,
  bFrom: Date | null,
  bTo: Date | null,
): boolean {
  if (aTo !== null && bFrom !== null && aTo <= bFrom) return false;
  if (bTo !== null && aFrom !== null && bTo <= aFrom) return false;
  return true;
}

/**
 * Decides which of the candidates are invalidated by the new fact.
 *
 * A candidate is invalidated when:
 *
 *  - its validity interval **overlaps** the new fact's, and
 *  - it **started before** the new fact.
 *
 * The second condition is what gives the direction: the more recent fact
 * closes the older one, not the other way around. If the candidate started
 * later, or if the intervals do not touch, they coexist — two facts can both
 * be true in different windows.
 *
 * A new fact without `validAt` invalidates nothing: without knowing since when
 * it holds, there is no way to say what it closed and at what moment.
 */
export function resolveContradictions(
  incoming: Fact,
  candidates: Fact[],
): Invalidation[] {
  const from = incoming.validAt;
  if (from === null) return [];

  const invalidations: Invalidation[] = [];

  for (const candidate of candidates) {
    if (candidate.id === incoming.id) continue;

    // It was already closed before the new one started.
    if (candidate.invalidAt !== null && candidate.invalidAt <= from) continue;

    if (!overlaps(candidate.validAt, candidate.invalidAt, from, incoming.invalidAt)) {
      continue;
    }

    // Without a direction there is nothing to close.
    if (candidate.validAt === null || candidate.validAt >= from) continue;

    invalidations.push({ fact: candidate, invalidAt: from });
  }

  return invalidations;
}

/**
 * Applies an invalidation: closes the real-world interval (`invalidAt`) and
 * records when the system learned it (`expiredAt`), unless it already knew.
 *
 * Returns a new fact — the original is left untouched.
 */
export function applyInvalidation(
  invalidation: Invalidation,
  now: Date,
): Fact {
  return {
    ...invalidation.fact,
    invalidAt: invalidation.invalidAt,
    expiredAt: invalidation.fact.expiredAt ?? now,
  };
}
