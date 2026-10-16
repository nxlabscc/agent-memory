import { describe, expect, test } from "bun:test";
import { applyInvalidation, resolveContradictions } from "./invalidation";
import { isValidAt, type Fact } from "./types";

const march = new Date("2026-03-01T00:00:00Z");
const may = new Date("2026-05-01T00:00:00Z");
const july = new Date("2026-07-01T00:00:00Z");
const september = new Date("2026-09-01T00:00:00Z");

let seq = 0;
function fact(validAt: Date | null, invalidAt: Date | null = null): Fact {
  return {
    id: `f${++seq}`,
    tenantId: "t1",
    sourceEntityId: "ana",
    targetEntityId: "company",
    fact: "Ana works at X",
    episodeIds: ["ep1"],
    createdAt: march,
    expiredAt: null,
    validAt,
    invalidAt,
  };
}

describe("resolveContradictions", () => {
  test("the new fact closes the old one that was still open", () => {
    const old = fact(march);
    const incoming = fact(july);

    const [inv] = resolveContradictions(incoming, [old]);
    expect(inv!.fact.id).toBe(old.id);
    expect(inv!.invalidAt).toBe(july);
  });

  test("does not close one that started later: the direction is from new to old", () => {
    const later = fact(september);
    const incoming = fact(july);
    expect(resolveContradictions(incoming, [later])).toEqual([]);
  });

  test("does not touch what was already closed before the new one started", () => {
    const closed = fact(march, may);
    const incoming = fact(july);
    expect(resolveContradictions(incoming, [closed])).toEqual([]);
  });

  test("intervals that do not touch coexist", () => {
    const old = fact(march, may);
    const incoming = fact(may, july);
    expect(resolveContradictions(incoming, [old])).toEqual([]);
  });

  test("overlapping intervals do get closed", () => {
    const old = fact(march, september);
    const incoming = fact(july);
    const [inv] = resolveContradictions(incoming, [old]);
    expect(inv!.invalidAt).toBe(july);
  });

  test("a new fact without validAt invalidates nothing", () => {
    const old = fact(march);
    const incoming = fact(null);
    expect(resolveContradictions(incoming, [old])).toEqual([]);
  });

  test("a candidate without validAt cannot be closed: there is no direction", () => {
    const noStart = fact(null);
    const incoming = fact(july);
    expect(resolveContradictions(incoming, [noStart])).toEqual([]);
  });

  test("a fact does not invalidate itself", () => {
    const f = fact(march);
    expect(resolveContradictions(f, [f])).toEqual([]);
  });

  test("closes several candidates at once", () => {
    const a = fact(march);
    const b = fact(may);
    const incoming = fact(july);
    expect(resolveContradictions(incoming, [a, b])).toHaveLength(2);
  });

  test("with no candidates there is nothing to close", () => {
    expect(resolveContradictions(fact(july), [])).toEqual([]);
  });
});

describe("applyInvalidation", () => {
  test("closes the real-world interval and records when the system learned it", () => {
    const old = fact(march);
    const [inv] = resolveContradictions(fact(july), [old]);
    const closed = applyInvalidation(inv!, september);

    expect(closed.invalidAt).toBe(july);
    expect(closed.expiredAt).toBe(september);
  });

  test("does not overwrite an existing expiredAt", () => {
    const alreadyExpired = { ...fact(march), expiredAt: may };
    const [inv] = resolveContradictions(fact(july), [alreadyExpired]);
    expect(applyInvalidation(inv!, september).expiredAt).toBe(may);
  });

  test("does not mutate the original", () => {
    const old = fact(march);
    const [inv] = resolveContradictions(fact(july), [old]);
    applyInvalidation(inv!, september);
    expect(old.invalidAt).toBeNull();
  });

  test("the closed fact is still queryable within its window", () => {
    const old = fact(march);
    const [inv] = resolveContradictions(fact(july), [old]);
    const closed = applyInvalidation(inv!, september);

    expect(isValidAt(closed, may)).toBe(true);
    expect(isValidAt(closed, september)).toBe(false);
  });
});
