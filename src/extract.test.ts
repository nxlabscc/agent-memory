import { describe, expect, test } from "bun:test";
import { extractFacts, extractionPrompt, parseExtraction } from "./extract";
import type { ConversationTurn } from "./extract";

const episodeId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-08T12:00:00Z");
const ctx = { episodeId, now };

const turns: ConversationTurn[] = [
  { role: "user", text: "remember that I use DeepSeek for everything" },
  { role: "assistant", text: "noted" },
];

describe("extractionPrompt", () => {
  test("includes the transcript with who said what", () => {
    const prompt = extractionPrompt(turns);
    expect(prompt).toContain("User: remember that I use DeepSeek for everything");
    expect(prompt).toContain("Assistant: noted");
  });

  test("asks for JSON and nothing else: the answer is parsed, not read", () => {
    expect(extractionPrompt(turns)).toContain("ONLY a JSON array");
  });

  // Preventive, not corrective: names are the key the dedup uses to join
  // entities, so if one extraction says "user" and another says "Ana", the
  // facts about the same person hang off two nodes that never connect.
  test("asks for third person: the fact is read back outside its conversation", () => {
    expect(extractionPrompt(turns)).toContain("THIRD PERSON");
  });

  // The fact is stored to be brought back into a context that may be in any
  // language, and text retrieval compares words: a fact in Spanish is not
  // found by searching in English.
  // Measured: asking the model to infer the language scores 0/5 against the
  // real API; naming it scores 5/5. That is why it comes in as data and not as
  // a rule.
  test("without a language, it does not invent a language rule", () => {
    expect(extractionPrompt(turns)).not.toContain("The conversation is in");
  });

  test("with a language, it names it and says not to use the prompt's", () => {
    const prompt = extractionPrompt(turns, { language: "Spanish" });
    expect(prompt).toContain("The conversation is in Spanish");
    expect(prompt).toContain("not in the language of these instructions");
  });

  test("the `user` label survives the language change: it is a key", () => {
    expect(extractionPrompt(turns, { language: "Spanish" })).toContain(
      'the word "user", which is a key',
    );
  });

  test("pins the person's label so every extraction agrees on it", () => {
    expect(extractionPrompt(turns)).toContain('write exactly "user"');
  });
});

/** The happy paths return candidates; failing here is a bug in the test. */
function draftsFrom(raw: string) {
  const outcome = parseExtraction(raw, ctx);
  if (!outcome.ok) throw new Error(`expected a usable answer: ${outcome.reason}`);
  return outcome.drafts;
}

describe("parseExtraction", () => {
  test("turns each element into a candidate with provenance and validity", () => {
    const drafts = draftsFrom(
      '[{"source":"Ana","target":"DeepSeek","fact":"Ana uses DeepSeek"}]',
    );
    expect(drafts).toEqual([
      {
        sourceName: "Ana",
        targetName: "DeepSeek",
        fact: "Ana uses DeepSeek",
        validAt: now,
        episodeId,
      },
    ]);
  });

  test("a code fence does not break extraction even though the prompt forbids it", () => {
    const raw = '```json\n[{"source":"a","target":"b","fact":"a with b"}]\n```';
    expect(draftsFrom(raw)).toHaveLength(1);
  });

  test("an empty list is a valid answer: there was nothing to remember", () => {
    expect(parseExtraction("[]", ctx)).toEqual({ ok: true, drafts: [] });
  });

  // What follows is the distinction that keeps conversation from being lost:
  // the caller only advances its mark on ok:true.
  test("an answer that is not JSON is reported as unreadable, not empty", () => {
    const outcome = parseExtraction("I found nothing relevant", ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ reason: "not-json" });
  });

  test("JSON cut off halfway is reported as unreadable", () => {
    const outcome = parseExtraction('[{"source":"user","target":"Neo', ctx);
    expect(outcome.ok).toBe(false);
  });

  test("a lone object is not a list of facts", () => {
    const outcome = parseExtraction('{"source":"a","target":"b","fact":"c"}', ctx);
    expect(outcome).toMatchObject({ ok: false, reason: "not-a-list" });
  });

  test("drops incomplete elements and keeps the sound ones", () => {
    const raw = JSON.stringify([
      { source: "Ana", target: "Atlas", fact: "Ana works on Atlas" },
      { source: "Ana", fact: "missing target" },
      { source: "", target: "b", fact: "empty source" },
      { source: "  ", target: "b", fact: "blank source" },
      { source: "a", target: "b", fact: "   " },
      null,
      "loose text",
      { source: 42, target: "b", fact: "source is not text" },
    ]);
    const drafts = draftsFrom(raw);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.fact).toBe("Ana works on Atlas");
  });

  test("trims whitespace from names: they are the resolution key", () => {
    const drafts = draftsFrom(
      '[{"source":" Ana ","target":"\\tAtlas\\n","fact":" works "}]',
    );
    expect(drafts[0]).toMatchObject({
      sourceName: "Ana",
      targetName: "Atlas",
      fact: "works",
    });
  });

  test("every candidate from one extraction shares the episode", () => {
    const raw = JSON.stringify([
      { source: "a", target: "b", fact: "one" },
      { source: "c", target: "d", fact: "two" },
    ]);
    const drafts = draftsFrom(raw);
    expect(drafts.every((d) => d.episodeId === episodeId)).toBe(true);
    expect(drafts.every((d) => d.validAt === now)).toBe(true);
  });
});

describe("extractFacts", () => {
  test("does not call the model when there is nothing to extract", async () => {
    let calls = 0;
    const outcome = await extractFacts(
      async () => {
        calls++;
        return "[]";
      },
      { turns: [], episodeId, now },
    );
    expect(calls).toBe(0);
    expect(outcome).toEqual({ ok: true, drafts: [] });
  });

  test("passes the prompt to the model and returns what could be parsed", async () => {
    let seen = "";
    const outcome = await extractFacts(
      async (prompt) => {
        seen = prompt;
        return '[{"source":"Ana","target":"DeepSeek","fact":"Ana uses DeepSeek"}]';
      },
      { turns, episodeId, now },
    );
    // extractFacts passes the turn's date as "today", so the prompt is not the
    // one from a bare call.
    expect(seen).toBe(extractionPrompt(turns, { today: now }));
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok && outcome.drafts).toHaveLength(1);
  });
});

describe("dates said by the person", () => {
  test("tells the model what day it is: without it there is no 'since March'", () => {
    const prompt = extractionPrompt(turns, { today: new Date("2026-08-09T15:00:00Z") });
    expect(prompt).toContain("Today is 2026-08-09.");
  });

  test("without `today`, it does not lie with a date", () => {
    expect(extractionPrompt(turns)).not.toContain("Today is");
  });

  test("asks for the date only if the person said it, and forbids guessing", () => {
    expect(extractionPrompt(turns)).toContain("only when the person said so");
    expect(extractionPrompt(turns)).toContain("Do not guess a date");
  });

  test("a stated date is the fact's `valid_at`", () => {
    const drafts = draftsFrom(
      '[{"source":"user","target":"Rosario","fact":"lives in Rosario","since":"2026-03-01"}]',
    );
    expect(drafts[0]!.validAt).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  test("with no stated date, the fact holds from the turn", () => {
    const drafts = draftsFrom('[{"source":"a","target":"b","fact":"c","since":null}]');
    expect(drafts[0]!.validAt).toEqual(now);
  });

  // Inventing a valid_at from garbage is worse than not having one: it shifts
  // the direction of contradictions, which is what decides what gets
  // invalidated.
  test("an unreadable date counts the same as no date at all", () => {
    for (const garbage of ['"yesterday"', '"2026-13-45"', '"03/01/2026"', "42", "{}"]) {
      const drafts = draftsFrom(
        `[{"source":"a","target":"b","fact":"c","since":${garbage}}]`,
      );
      expect(drafts[0]!.validAt, `since=${garbage}`).toEqual(now);
    }
  });
});
