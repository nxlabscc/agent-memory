import { describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS } from "./embedding";
import { migrations } from "./migrations";

describe("EMBEDDING_DIMENSIONS", () => {
  // The number lives in two places and they must agree: if the column and the
  // provider differ, Postgres rejects every write and the error only shows up
  // at runtime.
  test("the migration fixes the same length the code declares", () => {
    const sql = migrations().map((m) => m.sql).join("\n");
    const declared = [...sql.matchAll(/VECTOR\((\d+)\)/gi)].map((m) => Number(m[1]));
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared)).toEqual(new Set([EMBEDDING_DIMENSIONS]));
  });

  test("it fits in the pgvector index, which goes up to 2000", () => {
    expect(EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(2000);
  });
});
