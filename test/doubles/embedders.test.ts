import { describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS } from "../../src/embedding";
import { cosineSimilarity } from "../../src/rerank";
import { createStubEmbedder } from "./embedders";

const embedder = createStubEmbedder();

describe("createStubEmbedder", () => {
  test("returns a vector of the declared length", async () => {
    const v = await embedder.embed("the user uses Neovim");
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  test("the same text gives the same vector: without that nothing is reproducible", async () => {
    expect(await embedder.embed("hello")).toEqual(await embedder.embed("hello"));
  });

  test("different texts give different vectors", async () => {
    const a = await embedder.embed("the user has a cat");
    const b = await embedder.embed("the user watches birds");
    expect(a).not.toEqual(b);
  });

  // Everything downstream compares by cosine, and a vector with the wrong
  // magnitude fails in a way that is hard to see: the ordering comes out odd and
  // nothing throws.
  test("vectors come normalized", async () => {
    const v = await embedder.embed("anything at all");
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test("similarity with itself is 1, and with another text it is not", async () => {
    const a = await embedder.embed("the user uses Neovim");
    const b = await embedder.embed("the user uses VSCode");
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, b)).toBeLessThan(0.5);
  });

  test("a batch keeps the order and matches the single calls", async () => {
    const texts = ["one", "two", "three"];
    const batch = await embedder.embedBatch(texts);
    expect(batch).toHaveLength(3);
    for (let i = 0; i < texts.length; i++) {
      expect(batch[i]).toEqual(await embedder.embed(texts[i]!));
    }
  });

  test("an empty batch calls nothing", async () => {
    expect(await embedder.embedBatch([])).toEqual([]);
  });

  // The vectors carry no semantics, on purpose: a test that depends on "cat"
  // being close to "kitten" is testing the model, not our code.
  test("the name says it is a stub, so it is not mistaken for real data", () => {
    expect(embedder.name).toContain("stub");
  });

  test("it can be asked for another length, to test the mismatch", async () => {
    const small = createStubEmbedder(8);
    expect(await small.embed("x")).toHaveLength(8);
    expect(small.dimensions).toBe(8);
  });
});
