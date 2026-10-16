import { describe, expect, test } from "bun:test";
import {
  cosineSimilarity,
  maximalMarginalRelevance,
  reciprocalRankFusion,
  type Embedded,
} from "./rerank";

const r = (id: string) => ({ id });
const ids = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id);

describe("reciprocalRankFusion", () => {
  test("with a single ranking it keeps the order", () => {
    expect(ids(reciprocalRankFusion([[r("a"), r("b"), r("c")]]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("what appears in several lists rises above what comes first in one", () => {
    const byCosine = [r("cosine-only"), r("in-both")];
    const byText = [r("text-only"), r("in-both")];
    expect(ids(reciprocalRankFusion([byCosine, byText]))[0]).toBe("in-both");
  });

  test("deduplicates: each id appears only once", () => {
    const out = reciprocalRankFusion([[r("a"), r("b")], [r("a")]]);
    expect(ids(out).filter((id) => id === "a")).toHaveLength(1);
  });

  test("k controls how much position weighs against appearing in several lists", () => {
    // "top" comes first in a single list; "repeated" comes sixth in both.
    const listA = [r("top"), r("a1"), r("a2"), r("a3"), r("a4"), r("repeated")];
    const listB = [r("b1"), r("b2"), r("b3"), r("b4"), r("b5"), r("repeated")];

    const order = (k: number) => {
      const out = ids(reciprocalRankFusion([listA, listB], k));
      return { top: out.indexOf("top"), repeated: out.indexOf("repeated") };
    };

    // With a small k position rules: coming first in one list weighs more.
    const small = order(1);
    expect(small.top).toBeLessThan(small.repeated);

    // With a large k agreement rules: appearing in both weighs more.
    const large = order(60);
    expect(large.repeated).toBeLessThan(large.top);
  });

  test("empty lists do not break it", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  test("preserves the original object, not just the id", () => {
    const [out] = reciprocalRankFusion([[{ id: "a", fact: "hello" }]]);
    expect(out!.fact).toBe("hello");
  });
});

describe("cosineSimilarity", () => {
  test("identical vectors give 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  test("orthogonal vectors give 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("opposite vectors give -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  test("magnitude does not matter, only direction", () => {
    expect(cosineSimilarity([1, 1], [10, 10])).toBeCloseTo(1);
  });

  test("different lengths or a zero vector give 0", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("maximalMarginalRelevance", () => {
  const query = [1, 0];
  // Relevance 0.8. It is the most relevant, so it always comes first.
  const a: Embedded = { id: "a1", embedding: [0.8, 0.6] };
  // Relevance 0.79 but nearly identical to `a`: adds little on top of it.
  const nearlyA: Embedded = { id: "a2", embedding: [0.79, 0.61] };
  // Relevance 0.6 and orthogonal to `a`: less relevant, but adds something new.
  const different: Embedded = { id: "b", embedding: [0.6, -0.8] };

  test("lambda 1 is pure relevance: it does not diversify", () => {
    const out = maximalMarginalRelevance([a, nearlyA, different], query, 1);
    expect(ids(out)).toEqual(["a1", "a2", "b"]);
  });

  test("with an intermediate lambda the second place goes to the different one, not the near-duplicate", () => {
    const out = maximalMarginalRelevance([a, nearlyA, different], query, 0.5);
    expect(ids(out).slice(0, 2)).toEqual(["a1", "b"]);
  });

  test("respects the limit", () => {
    expect(maximalMarginalRelevance([a, nearlyA, different], query, 0.7, 2))
      .toHaveLength(2);
  });

  test("returns every candidate when no limit is given", () => {
    expect(maximalMarginalRelevance([a, different], query)).toHaveLength(2);
  });

  test("with no candidates it returns empty", () => {
    expect(maximalMarginalRelevance([], query)).toEqual([]);
  });

  test("does not repeat candidates", () => {
    const out = maximalMarginalRelevance([a, nearlyA, different], query, 0.7);
    expect(new Set(ids(out)).size).toBe(3);
  });
});
