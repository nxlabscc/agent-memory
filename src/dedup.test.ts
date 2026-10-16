import { describe, expect, test } from "bun:test";
import {
  buildCandidateIndex,
  findRepeatedFact,
  isFuzzyEligible,
  jaccard,
  minhashSignature,
  nameEntropy,
  normalizeExact,
  normalizeFuzzy,
  resolveEntities,
  resolveName,
  sameFactText,
  shingles,
} from "./dedup";
import type { Entity } from "./types";

function entity(id: string, name: string): Entity {
  return { id, tenantId: "t1", name, summary: "", attributes: {} };
}

describe("normalizeExact", () => {
  test("collapses whitespace and lowercases", () => {
    expect(normalizeExact("  Proyecto   X  ")).toBe("proyecto x");
  });

  test("strips accents", () => {
    expect(normalizeExact("José María")).toBe("jose maria");
  });

  test("two spellings of the same name collapse to the same value", () => {
    expect(normalizeExact("Análisis Financiero")).toBe(
      normalizeExact("analisis  financiero"),
    );
  });
});

describe("normalizeFuzzy", () => {
  test("keeps only alphanumerics and apostrophes", () => {
    expect(normalizeFuzzy("Proyecto X-1 (v2)")).toBe("proyectox1v2");
  });

  test("keeps the apostrophe", () => {
    expect(normalizeFuzzy("O'Brien")).toBe("o'brien");
  });
});

describe("nameEntropy", () => {
  test("a repeated character carries no information", () => {
    expect(nameEntropy("aaaa")).toBe(0);
  });

  test("empty string gives zero", () => {
    expect(nameEntropy("")).toBe(0);
  });

  test("a real name clears the fuzzy threshold", () => {
    expect(nameEntropy("proyectomemoria")).toBeGreaterThan(2.5);
  });
});

describe("isFuzzyEligible", () => {
  test("rejects short names", () => {
    expect(isFuzzyEligible("abc")).toBe(false);
  });

  test("rejects long but repetitive names", () => {
    expect(isFuzzyEligible("aaaaaaaaaa")).toBe(false);
  });

  test("accepts a real name", () => {
    expect(isFuzzyEligible("proyectomemoria")).toBe(true);
  });
});

describe("shingles", () => {
  test("splits into overlapping 3-grams", () => {
    expect(shingles("abcde")).toEqual(new Set(["abc", "bcd", "cde"]));
  });

  test("a name shorter than the n-gram is a single shingle", () => {
    expect(shingles("ab")).toEqual(new Set(["ab"]));
  });

  test("empty string produces no shingles", () => {
    expect(shingles("").size).toBe(0);
  });
});

describe("jaccard", () => {
  test("identical sets give 1", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  test("disjoint sets give 0", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  test("partial overlap", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
  });
});

describe("minhashSignature", () => {
  test("is deterministic", () => {
    const s = shingles("proyectomemoria");
    expect(minhashSignature(s)).toEqual(minhashSignature(s));
  });

  test("identical sets give identical signatures", () => {
    expect(minhashSignature(shingles("analisisfinanciero"))).toEqual(
      minhashSignature(shingles("analisisfinanciero")),
    );
  });

  test("very different sets give different signatures", () => {
    expect(minhashSignature(shingles("analisisfinanciero"))).not.toEqual(
      minhashSignature(shingles("recetasdecocina")),
    );
  });
});

describe("resolveName", () => {
  test("resolves by exact name despite changes in case and spacing", () => {
    const index = buildCandidateIndex([entity("e1", "Proyecto Memoria")]);
    const r = resolveName("  proyecto   MEMORIA ", index);
    expect(r.match?.id).toBe("e1");
    expect(r.via).toBe("exact");
  });

  test("the exact path also runs for short names", () => {
    const index = buildCandidateIndex([entity("e1", "Ana")]);
    const r = resolveName("ana", index);
    expect(r.match?.id).toBe("e1");
    expect(r.via).toBe("exact");
  });

  test("two candidates with the same name stay unresolved, for the LLM", () => {
    const index = buildCandidateIndex([
      entity("e1", "Proyecto X"),
      entity("e2", "proyecto x"),
    ]);
    const r = resolveName("Proyecto X", index);
    expect(r.match).toBeNull();
    expect(r.via).toBeNull();
  });

  test("resolves a spelling variant by similarity", () => {
    const index = buildCandidateIndex([entity("e1", "Análisis Financiero")]);
    const r = resolveName("analisis financiero!", index);
    expect(r.match?.id).toBe("e1");
    expect(r.via).toBe("fuzzy");
  });

  test("does not merge two distinct entities that share a prefix", () => {
    const index = buildCandidateIndex([entity("e1", "Proyecto Memoria")]);
    const r = resolveName("Proyecto Voz", index);
    expect(r.match).toBeNull();
  });

  test("a short, unknown name does not fall through to the fuzzy path", () => {
    const index = buildCandidateIndex([entity("e1", "Ana")]);
    const r = resolveName("Ann", index);
    expect(r.match).toBeNull();
    expect(r.via).toBeNull();
  });

  test("with no candidates, nothing resolves", () => {
    const index = buildCandidateIndex([]);
    expect(resolveName("Proyecto Memoria", index).match).toBeNull();
  });
});

describe("resolveEntities", () => {
  test("separates what was resolved from what goes to the LLM", () => {
    const candidates = [
      entity("e1", "Proyecto Memoria"),
      entity("e2", "Marta"),
    ];
    const { resolutions, unresolved } = resolveEntities(
      ["proyecto memoria", "Marta", "Una Entidad Nueva"],
      candidates,
    );

    expect(resolutions).toHaveLength(3);
    expect(resolutions[0]!.match?.id).toBe("e1");
    expect(resolutions[1]!.match?.id).toBe("e2");
    expect(resolutions[2]!.match).toBeNull();
    expect(unresolved).toEqual(["Una Entidad Nueva"]);
  });

  test("with no extracted names there is nothing to resolve", () => {
    const { resolutions, unresolved } = resolveEntities([], [entity("e1", "X")]);
    expect(resolutions).toHaveLength(0);
    expect(unresolved).toHaveLength(0);
  });

  test("entities from another tenant never get here: the caller filters", () => {
    // The index is built from whatever the caller passes in. If the caller
    // brings candidates from another tenant, it merges them — which is why
    // tenant scoping belongs in the code that looks up candidates, not here.
    const foreign = entity("other", "Proyecto Memoria");
    foreign.tenantId = "t2";
    const r = resolveName("Proyecto Memoria", buildCandidateIndex([foreign]));
    expect(r.match?.tenantId).toBe("t2");
  });
});

describe("sameFactText", () => {
  test("the same statement said twice is the same fact", () => {
    expect(sameFactText("user edits in Neovim", "user edits in Neovim")).toBe(true);
  });

  test("punctuation, case and accents do not make a new fact", () => {
    expect(sameFactText("El usuario usa Neovim.", "el usuario usa neovim")).toBe(true);
    expect(sameFactText("Le gustan los pájaros", "le gustan los pajaros")).toBe(true);
  });

  // What it must NOT merge. Two statements about the same entities share
  // almost every word and say the opposite; treating them as equal does not
  // leave an extra duplicate, it erases a fact.
  test("saying the opposite about the same entities is not repeating", () => {
    expect(sameFactText("el usuario trabaja en Atlas", "el usuario dejó de trabajar en Atlas"))
      .toBe(false);
    expect(sameFactText("al usuario le gusta el café", "al usuario no le gusta el café"))
      .toBe(false);
  });

  // This is the residue left for the LLM: the algorithm cannot see it.
  test("a paraphrase is not recognized, and that is known", () => {
    expect(
      sameFactText(
        "al usuario le gusta Taylor Swift",
        "el usuario disfruta la música de Taylor Swift",
      ),
    ).toBe(false);
  });

  test("an empty statement repeats nothing", () => {
    expect(sameFactText("", "el usuario usa Neovim")).toBe(false);
    expect(sameFactText("   ", "")).toBe(false);
  });
});

describe("findRepeatedFact", () => {
  const current = [
    { id: "1", fact: "el usuario usa Neovim" },
    { id: "2", fact: "el usuario mira aves los domingos" },
  ];

  test("returns the fact the statement repeats", () => {
    expect(findRepeatedFact("El usuario usa Neovim.", current)?.id).toBe("1");
  });

  test("returns null when the statement is new", () => {
    expect(findRepeatedFact("el usuario tiene un gato", current)).toBeNull();
  });

  test("with no candidates there is nothing to repeat", () => {
    expect(findRepeatedFact("el usuario usa Neovim", [])).toBeNull();
  });
});
