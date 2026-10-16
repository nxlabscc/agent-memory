import { describe, expect, test } from "bun:test";
import {
  createMemoryStore,
  guard,
  InvalidSchemaError,
  requireSchema,
  requireTenant,
  TenantRequiredError,
  UnscopedQueryError,
  type Sql,
} from "./store";

const LITERAL = Symbol("literal");

/** The text of a literal fragment (`sql.unsafe`), or null if it is a parameter. */
function fragment(value: unknown): string | null {
  return typeof value === "object" && value !== null && LITERAL in value
    ? (value as { [LITERAL]: string })[LITERAL]
    : null;
}

/** Fake client: talks to nobody, only records the SQL it was asked to run. */
function spy() {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    // Table names arrive as literal fragments: they are pasted into the text,
    // just like the driver does. Everything else is a parameter.
    queries.push(
      strings.reduce(
        (text, part, i) =>
          text + part + (i < values.length ? (fragment(values[i]) ?? "?") : ""),
        "",
      ),
    );
    params.push(values);
    return Promise.resolve([]);
  }) as unknown as Sql;
  // The real driver marks JSON values so it doesn't serialize them twice; the
  // double has to offer the same or the store can't call it.
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
  (sql as unknown as { unsafe: (f: string) => unknown }).unsafe = (f) => ({ [LITERAL]: f });
  return { sql, queries, params };
}

const TENANT = "aaaaaaaa-0000-0000-0000-000000000000";

describe("requireTenant", () => {
  test("accepts a real tenant", () => {
    expect(requireTenant(TENANT, "op")).toBe(TENANT);
  });

  for (const bad of [undefined, null, "", "   "]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => requireTenant(bad as never, "op")).toThrow(
        TenantRequiredError,
      );
    });
  }

  test("the error says which operation failed", () => {
    expect(() => requireTenant("", "insertFact")).toThrow("insertFact");
  });
});

describe("guard", () => {
  test("lets through a query that mentions tenant_id", async () => {
    const { sql, queries } = spy();
    await guard(sql, "op")`SELECT 1 FROM t WHERE tenant_id = ${TENANT}`;
    expect(queries).toHaveLength(1);
  });

  test("throws if the query does not mention tenant_id", () => {
    const { sql } = spy();
    expect(() => guard(sql, "op")`SELECT 1 FROM t`).toThrow(UnscopedQueryError);
  });

  test("does not let the query reach the database", () => {
    const { sql, queries } = spy();
    try {
      guard(sql, "op")`DELETE FROM memory.facts`;
    } catch {
      /* expected */
    }
    expect(queries).toHaveLength(0);
  });

  test("is not fooled by passing the name as a parameter", () => {
    const { sql } = spy();
    // The interpolated value doesn't count: what matters is the SQL text.
    expect(() => guard(sql, "op")`SELECT 1 FROM t WHERE x = ${"tenant_id"}`)
      .toThrow(UnscopedQueryError);
  });
});

describe("createMemoryStore — every operation requires a tenant", () => {
  const store = createMemoryStore(spy().sql);

  const cases: [string, () => Promise<unknown>][] = [
    ["insertEpisode", () =>
      store.insertEpisode("", {
        id: "e1",
        source: { kind: "conversation", sessionId: "s", messageIdFrom: "1", messageIdTo: "2" },
        contentSha256: "h",
        validAt: new Date(),
      })],
    ["getEpisodes", () => store.getEpisodes("", ["e1"])],
    ["insertEntity", () =>
      store.insertEntity("", { id: "x", name: "X", normalizedName: "x" })],
    ["candidateEntities", () => store.candidateEntities("")],
    ["insertFact", () =>
      store.insertFact("", {
        id: "f1",
        sourceEntityId: "a",
        targetEntityId: "b",
        fact: "something",
        agent: "assistant",
        validAt: null,
        episodeIds: [],
      })],
    ["factsValidAt", () => store.factsValidAt("", "assistant", new Date())],
    ["invalidateFact", () =>
      store.invalidateFact("", "f1", new Date(), new Date())],
  ];

  for (const [name, run] of cases) {
    test(`${name} rejects without a tenant`, async () => {
      await expect(run()).rejects.toThrow(TenantRequiredError);
    });
  }
});

describe("createMemoryStore — every query carries the scope", () => {
  test("every emitted statement mentions tenant_id", async () => {
    const { sql, queries } = spy();
    const store = createMemoryStore(sql);
    const now = new Date();

    await store.insertEpisode(TENANT, {
      id: "e1",
      source: { kind: "action", sessionId: "s", messageId: "m" },
      contentSha256: "h",
      validAt: now,
    });
    await store.getEpisodes(TENANT, ["e1"]);
    await store.insertEntity(TENANT, { id: "x", name: "X", normalizedName: "x" });
    await store.candidateEntities(TENANT);
    await store.insertFact(TENANT, {
      id: "f1",
      sourceEntityId: "a",
      targetEntityId: "b",
      fact: "something",
      agent: "assistant",
      validAt: now,
      episodeIds: ["e1"],
    });
    await store.factsValidAt(TENANT, "assistant", now);
    await store.invalidateFact(TENANT, "f1", now, now);

    expect(queries.length).toBeGreaterThanOrEqual(7);
    for (const query of queries) {
      expect(query, query.slice(0, 60)).toContain("tenant_id");
    }
  });

  test("the provenance link is scoped too", async () => {
    const { sql, queries } = spy();
    const store = createMemoryStore(sql);

    await store.insertFact(TENANT, {
      id: "f1",
      sourceEntityId: "a",
      targetEntityId: "b",
      fact: "something",
      agent: "assistant",
      validAt: null,
      episodeIds: ["e1", "e2"],
    });

    // Two statements: the fact and the link. Provenance carries its own
    // tenant_id and the composite FKs make the database reject someone else's
    // episode, instead of silently ignoring it.
    expect(queries).toHaveLength(2);
    const link = queries[1]!;
    expect(link).toContain("memory.fact_episodes");
    expect(link).toContain("tenant_id");
  });

  test("without episodes it doesn't emit the link", async () => {
    const { sql, queries } = spy();
    const store = createMemoryStore(sql);

    await store.insertFact(TENANT, {
      id: "f1",
      sourceEntityId: "a",
      targetEntityId: "b",
      fact: "something",
      agent: "assistant",
      validAt: null,
      episodeIds: [],
    });
    expect(queries).toHaveLength(1);
  });

  test("getEpisodes with an empty list doesn't query", async () => {
    const { sql, queries } = spy();
    const store = createMemoryStore(sql);
    expect(await store.getEpisodes(TENANT, [])).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  test("invalidateFact doesn't delete: it updates the interval", async () => {
    const { sql, queries } = spy();
    const store = createMemoryStore(sql);
    await store.invalidateFact(TENANT, "f1", new Date(), new Date());

    expect(queries[0]).toContain("UPDATE memory.facts");
    expect(queries[0]).not.toContain("DELETE");
    expect(queries[0]).toContain("COALESCE(expired_at");
  });
});

describe("the schema is chosen by whoever opens the memory", () => {
  test("by default, the tables are the ones in `memory`", async () => {
    const { sql, queries } = spy();
    await createMemoryStore(sql).candidateEntities(TENANT);
    expect(queries[0]).toContain("FROM memory.entities");
  });

  test("with another schema, every statement goes to that one", async () => {
    const { sql, queries } = spy();
    const store = createMemoryStore(sql, "custom_schema");
    await store.candidateEntities(TENANT);
    await store.insertFact(TENANT, {
      id: "f1",
      sourceEntityId: "a",
      targetEntityId: "b",
      fact: "something",
      agent: "assistant",
      validAt: null,
      episodeIds: ["e1"],
    });
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query).toContain("custom_schema.");
      expect(query).not.toContain("memory.");
    }
  });

  // The name is pasted into the SQL: an identifier can't travel as a parameter.
  for (const bad of ["", "Memory", "mem-ory", "x; DROP TABLE y", "1abc", 'a"b']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => requireSchema(bad)).toThrow(InvalidSchemaError);
      expect(() => createMemoryStore(spy().sql, bad)).toThrow(InvalidSchemaError);
    });
  }
});
