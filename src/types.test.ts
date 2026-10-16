import { describe, expect, test } from "bun:test";
import { isValidAt, type Fact } from "./types";

function fact(validAt: Date | null, invalidAt: Date | null): Fact {
  return {
    id: "f1",
    tenantId: "t1",
    sourceEntityId: "e1",
    targetEntityId: "e2",
    fact: "Alice works at Acme",
    episodeIds: ["ep1"],
    createdAt: new Date("2026-08-01T00:00:00Z"),
    expiredAt: null,
    validAt,
    invalidAt,
  };
}

const march = new Date("2026-03-01T00:00:00Z");
const june = new Date("2026-06-01T00:00:00Z");
const july = new Date("2026-07-01T00:00:00Z");
const august = new Date("2026-08-01T00:00:00Z");

describe("isValidAt", () => {
  test("a fact without an interval always holds", () => {
    expect(isValidAt(fact(null, null), june)).toBe(true);
  });

  test("it does not hold before validAt", () => {
    expect(isValidAt(fact(june, null), march)).toBe(false);
  });

  test("it holds from validAt inclusive", () => {
    expect(isValidAt(fact(june, null), june)).toBe(true);
  });

  test("it stops holding at invalidAt inclusive", () => {
    expect(isValidAt(fact(march, july), july)).toBe(false);
  });

  test("it holds inside the interval", () => {
    expect(isValidAt(fact(march, july), june)).toBe(true);
  });

  test("an invalidated fact still exists and can be queried within its window", () => {
    const invalidated = fact(march, july);
    expect(isValidAt(invalidated, august)).toBe(false);
    expect(isValidAt(invalidated, june)).toBe(true);
  });
});
