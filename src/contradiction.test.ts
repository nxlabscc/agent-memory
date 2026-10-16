import { describe, expect, test } from "bun:test";
import {
  contradictionPrompt,
  judgeContradictions,
  parseContradiction,
} from "./contradiction";

const existing = ["user uses Neovim", "user works at Acme"];

describe("contradictionPrompt", () => {
  test("numbers the statements: the model answers with those numbers", () => {
    const prompt = contradictionPrompt("user uses VSCode", existing);
    expect(prompt).toContain("1. user uses Neovim");
    expect(prompt).toContain("2. user works at Acme");
    expect(prompt).toContain("NEW statement:\nuser uses VSCode");
  });

  test("says explicitly that repeating is not contradicting", () => {
    expect(contradictionPrompt("x", existing)).toContain(
      "Repetition is not contradiction",
    );
  });

  test("and that when in doubt it should not invalidate: a mistake here erases something said", () => {
    expect(contradictionPrompt("x", existing)).toContain("When in doubt, leave it out");
  });
});

describe("parseContradiction", () => {
  test("converts the model's numbers, which start at 1, into indices", () => {
    expect(parseContradiction("[1]", 2)).toEqual([0]);
    expect(parseContradiction("[1, 2]", 2)).toEqual([0, 1]);
  });

  test("an empty list is a valid answer: it contradicts nothing", () => {
    expect(parseContradiction("[]", 2)).toEqual([]);
  });

  // Here silence is the right call, the opposite of extraction: an unreadable
  // answer must never end up closing a fact.
  test("an unreadable answer invalidates nothing", () => {
    expect(parseContradiction("contradicts none of them", 2)).toEqual([]);
    expect(parseContradiction("", 2)).toEqual([]);
    expect(parseContradiction('{"1": true}', 2)).toEqual([]);
  });

  test("a code fence does not break the answer", () => {
    expect(parseContradiction("```json\n[2]\n```", 2)).toEqual([1]);
  });

  test("a number outside the list points at nothing and is dropped", () => {
    expect(parseContradiction("[0]", 2)).toEqual([]);
    expect(parseContradiction("[3]", 2)).toEqual([]);
    expect(parseContradiction("[-1, 1, 99]", 2)).toEqual([0]);
  });

  test("anything that is not an integer is dropped", () => {
    expect(parseContradiction('["1", 1.5, null, 2]', 2)).toEqual([1]);
  });

  test("a repeated number counts once", () => {
    expect(parseContradiction("[1, 1, 1]", 2)).toEqual([0]);
  });
});

describe("judgeContradictions", () => {
  test("with no candidates it does not call the model: there is nothing to contradict", async () => {
    let calls = 0;
    const out = await judgeContradictions(
      async () => {
        calls++;
        return "[1]";
      },
      "user uses VSCode",
      [],
    );
    expect(calls).toBe(0);
    expect(out).toEqual([]);
  });

  test("returns the indices of what the model marked", async () => {
    const out = await judgeContradictions(async () => "[1]", "user uses VSCode", existing);
    expect(out).toEqual([0]);
  });
});
