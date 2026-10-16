import { describe, expect, test } from "bun:test";
import { migrations } from "./migrations";

describe("migrations", () => {
  test("there is at least one", () => {
    expect(migrations().length).toBeGreaterThan(0);
  });

  test("they come in lexicographic order, which is the application order", () => {
    const names = migrations().map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });

  test("names start with a sequence number", () => {
    for (const { name } of migrations()) {
      expect(name).toMatch(/^\d{3}_.+\.sql$/);
    }
  });

  test("none is empty", () => {
    for (const { name, sql } of migrations()) {
      expect(sql.trim().length, `${name} is empty`).toBeGreaterThan(0);
    }
  });

  test("names are unique: they are the consumer's tracking key", () => {
    const names = migrations().map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no semicolons in comments: it breaks runners that split on ;", () => {
    for (const { name, sql } of migrations()) {
      const offending = sql
        .split("\n")
        .filter((line) => /^\s*--.*;/.test(line));
      expect(offending, `${name}: ${offending.join(" | ")}`).toEqual([]);
    }
  });

  test("no FK is single-column: each tenant has its own relationship tree", () => {
    for (const { name, sql } of migrations()) {
      // A single-column FK can point at another tenant's row. All of them
      // must be composite over (tenant_id, id).
      const single = sql.match(/REFERENCES\s+memory\.\w+\s*\(\s*id\s*\)/gi);
      expect(single, `${name}: ${single?.join(" | ")}`).toBeNull();

      const inline = sql.match(/UUID[^,\n]*\bREFERENCES\b/gi);
      expect(inline, `${name}: inline FK on the column: ${inline?.join(" | ")}`)
        .toBeNull();
    }
  });

  test("every table with an id exposes it together with the tenant as an FK target", () => {
    // The rule is derived from the table, not from a list of exceptions: a
    // table with its own `id` can be pointed at, so the pair has to exist.
    // Tables without one —the provenance table, which is the link itself, or
    // the crawler state, which is one row per tenant— are nobody's target.
    for (const { name, sql } of migrations()) {
      for (const block of sql.split("CREATE TABLE IF NOT EXISTS ").slice(1)) {
        const table = /^(memory\.\w+)/.exec(block)?.[1] ?? "?";
        const body = block.slice(0, block.indexOf(");"));
        if (!/^\s*id\s+\w/m.test(body)) continue;
        expect(body, `${name}: ${table} does not expose (tenant_id, id)`)
          .toContain("UNIQUE (tenant_id, id)");
      }
    }
  });

  test("every object is created with IF NOT EXISTS: applying it twice cannot fail", () => {
    for (const { name, sql } of migrations()) {
      const creates = sql.match(/CREATE\s+(TABLE|INDEX|UNIQUE INDEX)\s+(?!IF NOT EXISTS)/gi);
      expect(creates, `${name} has a CREATE without IF NOT EXISTS`).toBeNull();
    }
  });
});

describe("migrations with another schema", () => {
  test("the chosen schema replaces the default one in all of them", () => {
    for (const { name, sql } of migrations("other_memory")) {
      expect(sql, name).not.toContain("{{schema}}");
      expect(sql, name).not.toMatch(/\bmemory\.\w/);
    }
    expect(migrations("other_memory")[0]!.sql).toContain("CREATE SCHEMA IF NOT EXISTS other_memory");
  });

  test("when none is chosen it is `memory`: what is already applied stays the same", () => {
    expect(migrations()[0]!.sql).toContain("CREATE SCHEMA IF NOT EXISTS memory;");
    expect(migrations()[0]!.sql).toContain("CREATE TABLE IF NOT EXISTS memory.facts");
  });

  test("a schema that is not a simple identifier never reaches the SQL", () => {
    expect(() => migrations("x; DROP SCHEMA public")).toThrow();
  });
});
