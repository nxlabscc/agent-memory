/**
 * Deterministic entity resolution.
 *
 * Runs **before** any LLM: whatever gets resolved here costs nothing.
 * Two paths, in order:
 *
 *  1. Identical normalized name. Always attempted, for any name.
 *  2. Fuzzy similarity via MinHash + LSH, verified with exact Jaccard. Only
 *     for names with enough entropy — on short or repetitive names the
 *     shingles are unreliable and the fuzzy match invents coincidences.
 *
 * Whatever it cannot resolve is marked as unresolved, and that is the only
 * thing that goes to the LLM.
 */

import type { Entity } from "./types";

// ─── Parameters ──────────────────────────────────────────────────────────────

/** N-gram size for the shingles. */
const SHINGLE_SIZE = 3;

/** MinHash permutations. BANDS × ROWS = PERMUTATIONS. */
const PERMUTATIONS = 64;
const BANDS = 8;
const ROWS_PER_BAND = PERMUTATIONS / BANDS;

/**
 * Jaccard threshold for accepting a candidate proposed by LSH.
 *
 * LSH generates candidates with an implicit threshold of (1/BANDS)^(1/ROWS) ≈ 0.77;
 * this exact check is what decides. High on purpose: a false positive merges
 * two distinct entities, and that does not undo itself.
 */
const JACCARD_MIN = 0.9;

/** Minimum number of characters to attempt the fuzzy path. */
const MIN_FUZZY_LENGTH = 6;

/** Minimum Shannon entropy (bits per character) to attempt the fuzzy path. */
const MIN_FUZZY_ENTROPY = 2.5;

// ─── Normalization ───────────────────────────────────────────────────────────

/** For exact comparison: lowercase, collapsed whitespace, accents stripped. */
export function normalizeExact(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** For shingles: only alphanumerics and apostrophes, whitespace removed. */
export function normalizeFuzzy(name: string): string {
  return normalizeExact(name).replace(/[^a-z0-9']/g, "");
}

// ─── Entropy ─────────────────────────────────────────────────────────────────

/**
 * Shannon entropy over the characters, in bits per character.
 *
 * Approximates how specific a name is. "aaaa" gives 0; a real name gives 2.5-4.
 */
export function nameEntropy(normalized: string): number {
  if (normalized.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of normalized) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / normalized.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Whether the name is reliable enough for the fuzzy path. */
export function isFuzzyEligible(normalizedFuzzy: string): boolean {
  return (
    normalizedFuzzy.length >= MIN_FUZZY_LENGTH &&
    nameEntropy(normalizedFuzzy) >= MIN_FUZZY_ENTROPY
  );
}

// ─── Shingles and MinHash ────────────────────────────────────────────────────

/** N-grams of `SHINGLE_SIZE` characters. A shorter name is a single shingle. */
export function shingles(normalizedFuzzy: string): Set<string> {
  if (normalizedFuzzy.length <= SHINGLE_SIZE) {
    return normalizedFuzzy.length > 0 ? new Set([normalizedFuzzy]) : new Set();
  }
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= normalizedFuzzy.length; i++) {
    out.add(normalizedFuzzy.slice(i, i + SHINGLE_SIZE));
  }
  return out;
}

/** Seeded 32-bit FNV-1a. Deterministic and dependency-free. */
function hashShingle(shingle: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < shingle.length; i++) {
    hash = (hash ^ shingle.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** MinHash signature: the minimum hash per permutation. */
export function minhashSignature(shingleSet: Set<string>): number[] {
  const signature = new Array<number>(PERMUTATIONS).fill(0xffffffff);
  for (const shingle of shingleSet) {
    for (let seed = 0; seed < PERMUTATIONS; seed++) {
      const h = hashShingle(shingle, seed);
      if (h < signature[seed]!) signature[seed] = h;
    }
  }
  return signature;
}

/** Splits the signature into bands. Two names are candidates if they share a band. */
export function lshBands(signature: number[]): string[] {
  const bands: string[] = [];
  for (let b = 0; b < BANDS; b++) {
    const from = b * ROWS_PER_BAND;
    bands.push(`${b}:${signature.slice(from, from + ROWS_PER_BAND).join(",")}`);
  }
  return bands;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// ─── Candidate index ─────────────────────────────────────────────────────────

export interface CandidateIndex {
  /** exact normalized name → entities with that name */
  byExactName: Map<string, Entity[]>;
  /** LSH band key → entities in that band */
  byBand: Map<string, Entity[]>;
  /** entity id → its shingles, for the exact check */
  shinglesById: Map<string, Set<string>>;
}

/**
 * Precomputes the lookup structures once per resolution run, instead of
 * recomputing them for every extracted name.
 */
export function buildCandidateIndex(candidates: Entity[]): CandidateIndex {
  const byExactName = new Map<string, Entity[]>();
  const byBand = new Map<string, Entity[]>();
  const shinglesById = new Map<string, Set<string>>();

  for (const entity of candidates) {
    const exact = normalizeExact(entity.name);
    const bucket = byExactName.get(exact);
    if (bucket) bucket.push(entity);
    else byExactName.set(exact, [entity]);

    const fuzzy = normalizeFuzzy(entity.name);
    if (!isFuzzyEligible(fuzzy)) continue;

    const shingleSet = shingles(fuzzy);
    shinglesById.set(entity.id, shingleSet);

    for (const band of lshBands(minhashSignature(shingleSet))) {
      const bandBucket = byBand.get(band);
      if (bandBucket) bandBucket.push(entity);
      else byBand.set(band, [entity]);
    }
  }

  return { byExactName, byBand, shinglesById };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export type ResolutionVia = "exact" | "fuzzy";

export interface Resolution {
  /** The name as the previous step extracted it. */
  name: string;
  /** The existing entity it resolved to, or `null` if it could not. */
  match: Entity | null;
  /** How it was resolved. `null` when unresolved — that goes to the LLM. */
  via: ResolutionVia | null;
}

/**
 * Resolves an extracted name against the candidate index.
 *
 * Returns `match: null` when there is no match **or** when there is ambiguity
 * (several candidates with the same normalized name). Ambiguity is exactly
 * what the LLM can break and the algorithm cannot.
 */
export function resolveName(name: string, index: CandidateIndex): Resolution {
  const exact = normalizeExact(name);
  const exactMatches = index.byExactName.get(exact) ?? [];

  if (exactMatches.length === 1) {
    return { name, match: exactMatches[0]!, via: "exact" };
  }
  if (exactMatches.length > 1) {
    // Ambiguous: the name alone is not enough to break the tie.
    return { name, match: null, via: null };
  }

  const fuzzy = normalizeFuzzy(name);
  if (!isFuzzyEligible(fuzzy)) {
    return { name, match: null, via: null };
  }

  const shingleSet = shingles(fuzzy);
  const seen = new Set<string>();
  let best: { entity: Entity; score: number } | null = null;

  for (const band of lshBands(minhashSignature(shingleSet))) {
    for (const candidate of index.byBand.get(band) ?? []) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const candidateShingles = index.shinglesById.get(candidate.id);
      if (!candidateShingles) continue;

      const score = jaccard(shingleSet, candidateShingles);
      if (score >= JACCARD_MIN && (best === null || score > best.score)) {
        best = { entity: candidate, score };
      }
    }
  }

  return best === null
    ? { name, match: null, via: null }
    : { name, match: best.entity, via: "fuzzy" };
}

export interface ResolutionResult {
  resolutions: Resolution[];
  /** The names the LLM has to disambiguate. */
  unresolved: string[];
}

/** Resolves a batch of extracted names against a set of existing entities. */
export function resolveEntities(
  extractedNames: string[],
  candidates: Entity[],
): ResolutionResult {
  const index = buildCandidateIndex(candidates);
  const resolutions = extractedNames.map((name) => resolveName(name, index));
  return {
    resolutions,
    unresolved: resolutions.filter((r) => r.match === null).map((r) => r.name),
  };
}

// ─── Repeated facts ──────────────────────────────────────────────────────────

/**
 * Threshold for statements. Higher than the one for names on purpose: a long
 * sentence shares many trigrams with another that says something different
 * about the same entities ("works at X" and "stopped working at X"), and
 * merging two distinct facts is worse than storing one twice.
 */
const FACT_JACCARD_MIN = 0.92;

/**
 * Cosine at or above which two statements are the same fact.
 *
 * Measured, not chosen: on 60 pairs from the STS Benchmark with human-annotated
 * similarity, the gemini-embedding-2 cosine correlates 0.913 (Spearman) with
 * people's judgement. Taking "equivalent" as a score >= 4 on its scale, this
 * cutoff lets through not a single false positive and catches 8 of 12.
 *
 * It could be 0.90 and catch 11, at the cost of one false positive: "Some men
 * are sawing" against "Men are sawing logs", which people scored 3.4 because
 * the second one says more. The error is not symmetric —merging two facts
 * erases what one of them said beyond the other, while keeping a duplicate
 * only takes up space—, so the cutoff sits on the conservative side.
 */
export const SAME_FACT_COSINE_MIN = 0.92;

/**
 * Whether two statements are the same fact, judged by their vectors.
 *
 * This is what the text path cannot do: "likes Taylor Swift" and "enjoys
 * Taylor Swift's music" do not share enough trigrams and do mean the same
 * thing. Measured against STS, comparing text catches NONE of the 12 pairs
 * people consider equivalent.
 */
export function sameFactVector(a: number[], b: number[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return false;
  return dot / (Math.sqrt(na) * Math.sqrt(nb)) >= SAME_FACT_COSINE_MIN;
}

/**
 * Whether two statements are the same fact said twice.
 *
 * Deterministic, and therefore conservative: it recognizes literal repetition
 * and repetition that only differs in punctuation or case. A paraphrase —"likes
 * Taylor Swift" against "enjoys Taylor Swift's music"— it does not recognize,
 * and that is the residue left for the LLM.
 */
export function sameFactText(a: string, b: string): boolean {
  const ea = normalizeExact(a);
  const eb = normalizeExact(b);
  // Two empty strings normalize the same, and "says nothing" does not repeat
  // "says nothing".
  if (ea.length === 0 || eb.length === 0) return false;
  if (ea === eb) return true;
  const fa = normalizeFuzzy(a);
  const fb = normalizeFuzzy(b);
  if (fa.length === 0 || fb.length === 0) return false;
  return jaccard(shingles(fa), shingles(fb)) >= FACT_JACCARD_MIN;
}

/**
 * The current fact that the new statement repeats, if any.
 *
 * `candidates` are the facts that already exist between the same two entities:
 * the pair generates the candidates, and the text decides.
 */
export function findRepeatedFact<T extends { fact: string; embedding?: number[] | null }>(
  text: string,
  candidates: T[],
  embedding?: number[] | null,
): T | null {
  return (
    candidates.find((candidate) => {
      // Vector first: it catches paraphrase, which is most of what gets
      // repeated. Text stays as the fallback for when there is no provider.
      if (embedding && candidate.embedding) {
        return sameFactVector(embedding, candidate.embedding);
      }
      return sameFactText(text, candidate.fact);
    }) ?? null
  );
}
