/**
 * The similarity threshold, against human judgement.
 *
 * These do not test our code: they test that the number the code uses is
 * still where the measurement put it. If someone lowers it to catch more
 * paraphrases, this is where the pairs it would start merging wrongly show up.
 *
 * The vectors are real, computed once with gemini-embedding-2 and stored. No
 * network.
 */
import { describe, expect, test } from "bun:test";
import { STS_PAIRS } from "../test/fixtures/corpus";
import fixture from "../test/fixtures/embeddings.json" with { type: "json" };
import {
  findRepeatedFact,
  SAME_FACT_COSINE_MIN,
  sameFactText,
  sameFactVector,
} from "./dedup";
import { cosineSimilarity } from "./rerank";

const vectors = (fixture as { vectors: Record<string, number[]> }).vectors;
const vec = (t: string) => vectors[t]!;

/** Equivalent on the STS scale: 4 is "mostly equivalent", 5 "completely". */
const EQUIVALENT = 4.0;
const pairs = STS_PAIRS.map((p) => ({ ...p, cos: cosineSimilarity(vec(p.a), vec(p.b)) }));

describe("the fixture", () => {
  test("has a vector for both sides of every pair", () => {
    for (const p of STS_PAIRS) {
      expect(vectors[p.a], p.a).toBeDefined();
      expect(vectors[p.b], p.b).toBeDefined();
    }
  });

  test("they are unit vectors: cosine compares direction", () => {
    for (const p of STS_PAIRS.slice(0, 5)) {
      const n = Math.sqrt(vec(p.a).reduce((acc, x) => acc + x * x, 0));
      expect(n).toBeCloseTo(1, 3);
    }
  });
});

describe("the 'same fact' threshold", () => {
  test("merges nothing people consider different", () => {
    const falsePositives = pairs.filter((p) => p.cos >= SAME_FACT_COSINE_MIN && p.score < EQUIVALENT);
    expect(
      falsePositives.map((p) => `${p.score} ${p.a} || ${p.b}`),
      "lowering the threshold starts merging these",
    ).toEqual([]);
  });

  test("catches most of what people consider the same", () => {
    const equivalents = pairs.filter((p) => p.score >= EQUIVALENT);
    const caught = equivalents.filter((p) => p.cos >= SAME_FACT_COSINE_MIN);
    expect(caught.length / equivalents.length).toBeGreaterThanOrEqual(0.6);
  });

  test("and the pair that decides the cutoff stays out", () => {
    // Human 3.4: the second one says what they were sawing. Cosine 0.910, so a
    // threshold of 0.90 would merge it and lose the "logs".
    const sawing = pairs.find((p) => p.a === "Some men are sawing.");
    expect(sawing).toBeDefined();
    expect(sawing!.cos).toBeLessThan(SAME_FACT_COSINE_MIN);
  });
});

describe("comparing vectors versus comparing text", () => {
  test("the text path catches none of the STS paraphrases", () => {
    const equivalents = pairs.filter((p) => p.score >= EQUIVALENT);
    expect(equivalents.length).toBeGreaterThan(0);
    expect(equivalents.filter((p) => sameFactText(p.a, p.b))).toEqual([]);
  });

  test("the vector path does, and that is why it exists", () => {
    const equivalents = pairs.filter((p) => p.score >= EQUIVALENT);
    const caught = equivalents.filter((p) => sameFactVector(vec(p.a), vec(p.b)));
    expect(caught.length).toBeGreaterThan(0);
  });

  test("comparing a vector with itself always gives the same fact", () => {
    const v = vec(STS_PAIRS[0]!.a);
    expect(sameFactVector(v, v)).toBe(true);
  });

  test("different lengths are not compared", () => {
    expect(sameFactVector([1, 0], [1, 0, 0])).toBe(false);
    expect(sameFactVector([], [])).toBe(false);
  });
});

describe("findRepeatedFact with STS vectors", () => {
  const equivalents = pairs.filter((p) => p.score >= EQUIVALENT && p.cos >= SAME_FACT_COSINE_MIN);
  const different = pairs.filter((p) => p.score < 3);

  test("a paraphrase people call equivalent finds the fact already stored", () => {
    expect(equivalents.length).toBeGreaterThan(0);
    for (const p of equivalents) {
      const stored = [{ id: "1", fact: p.a, embedding: vec(p.a) }];
      expect(findRepeatedFact(p.b, stored, vec(p.b))?.id, `${p.a} || ${p.b}`).toBe("1");
    }
  });

  test("two things people call different do not match", () => {
    expect(different.length).toBeGreaterThan(0);
    for (const p of different) {
      const stored = [{ id: "1", fact: p.a, embedding: vec(p.a) }];
      expect(findRepeatedFact(p.b, stored, vec(p.b)), `${p.a} || ${p.b}`).toBeNull();
    }
  });

  test("without vectors it falls back to text, and the paraphrase slips through", () => {
    const p = equivalents[0]!;
    expect(findRepeatedFact(p.b, [{ id: "1", fact: p.a }])).toBeNull();
  });
});
