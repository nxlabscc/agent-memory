import { describe, expect, test } from "bun:test";
import { createMemorySearch } from "./search";
import { AgentRequiredError, ModelRequiredError, TenantRequiredError, type Sql } from "./store";

const LITERAL = Symbol("literal");

/** The text of a literal fragment (`sql.unsafe`), or null if it is a parameter. */
function fragment(value: unknown): string | null {
  return typeof value === "object" && value !== null && LITERAL in value
    ? (value as { [LITERAL]: string })[LITERAL]
    : null;
}

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
  (sql as unknown as { unsafe: (f: string) => unknown }).unsafe = (f) => ({ [LITERAL]: f });
  return { sql, queries, params };
}

const TENANT = "aaaaaaaa-0000-0000-0000-000000000000";
const SEED = "11111111-1111-1111-1111-111111111111";
const MODEL = "gemini/gemini-embedding-2";
const AGENT = "assistant";

describe("every search requires a tenant", () => {
  const search = createMemorySearch(spy().sql);

  const cases: [string, () => Promise<unknown>][] = [
    ["factsByText", () => search.factsByText("", AGENT, "hello")],
    ["factsByVector", () => search.factsByVector("", AGENT, [1, 2], MODEL)],
    ["factsByTraversal", () => search.factsByTraversal("", AGENT, [SEED])],
    ["entitiesByText", () => search.entitiesByText("", "hello")],
    ["hybrid", () => search.hybrid("", AGENT, { text: "hello" })],
  ];

  for (const [name, run] of cases) {
    test(`${name} rejects without a tenant`, async () => {
      await expect(run()).rejects.toThrow(TenantRequiredError);
    });
  }
});

// A vector is only compared with others from the same model. It is required
// just like the tenant, because forgetting it doesn't fail: it returns a
// meaningless ranking.
describe("every vector search requires the model", () => {
  const search = createMemorySearch(spy().sql);

  const cases: [string, () => Promise<unknown>][] = [
    ["factsByVector", () => search.factsByVector(TENANT, AGENT, [1, 2], "")],
    ["hybrid with a vector", () => search.hybrid(TENANT, AGENT, { embedding: [1, 2] })],
  ];

  for (const [name, run] of cases) {
    test(`${name} rejects without a model`, async () => {
      await expect(run()).rejects.toThrow(ModelRequiredError);
    });
  }

  test("the query filters by embedding_model", async () => {
    const { sql, queries, params } = spy();
    await createMemorySearch(sql).factsByVector(TENANT, AGENT, [0.1, 0.2], MODEL);
    expect(queries[0]).toContain("embedding_model");
    expect(params[0]).toContain(MODEL);
  });

  test("a text-only search doesn't need a model", async () => {
    const { sql, queries } = spy();
    await createMemorySearch(sql).hybrid(TENANT, AGENT, { text: "project" });
    expect(queries).toHaveLength(1);
  });
});

// Facts belong to an agent: without saying which one, the search would return everyone's.
describe("every fact search requires the agent", () => {
  const search = createMemorySearch(spy().sql);

  const cases: [string, () => Promise<unknown>][] = [
    ["factsByText", () => search.factsByText(TENANT, "", "hello")],
    ["factsByVector", () => search.factsByVector(TENANT, "", [1, 2], MODEL)],
    ["factsByTraversal", () => search.factsByTraversal(TENANT, "", [SEED])],
    ["hybrid", () => search.hybrid(TENANT, "", { text: "hello" })],
  ];

  for (const [name, run] of cases) {
    test(`${name} rejects without an agent`, async () => {
      await expect(run()).rejects.toThrow(AgentRequiredError);
    });
  }

  test("every fact query filters by the agent", async () => {
    const { sql, queries, params } = spy();
    const search = createMemorySearch(sql);

    await search.factsByText(TENANT, AGENT, "project");
    await search.factsByVector(TENANT, AGENT, [0.1, 0.2], MODEL);
    await search.factsByTraversal(TENANT, AGENT, [SEED]);

    expect(queries).toHaveLength(3);
    queries.forEach((query, i) => {
      expect(query).toContain("f.agent = ?");
      expect(params[i]).toContain(AGENT);
    });
  });

  test("the traversal filters by agent in the recursive term too", async () => {
    const { sql, queries } = spy();
    await createMemorySearch(sql).factsByTraversal(TENANT, AGENT, [SEED]);
    expect(/JOIN memory\.facts f[\s\S]*?ON f\.tenant_id = \?\s+AND f\.agent = \?/.test(queries[0]!)).toBe(true);
  });
});

describe("every search is scoped", () => {
  test("every query mentions tenant_id", async () => {
    const { sql, queries } = spy();
    const search = createMemorySearch(sql);

    await search.factsByText(TENANT, AGENT, "project");
    await search.factsByVector(TENANT, AGENT, [0.1, 0.2], MODEL);
    await search.factsByTraversal(TENANT, AGENT, [SEED]);
    await search.entitiesByText(TENANT, "project");

    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query).toContain("tenant_id");
    }
  });

  test("the traversal filters by tenant in the base term and in the recursive one", async () => {
    const { sql, queries } = spy();
    await createMemorySearch(sql).factsByTraversal(TENANT, AGENT, [SEED]);

    const cte = queries[0]!;
    // Three occurrences: seeds, recursive term, and the final SELECT. If the
    // recursive one is missing, the traversal crosses tenants from the second
    // hop on and no simple read test catches it.
    const inBase = /FROM memory\.entities[\s\S]*?e\.tenant_id = \?/.test(cte);
    const inRecursive = /JOIN memory\.facts f[\s\S]*?ON f\.tenant_id = \?/.test(cte);
    const inFinal = /JOIN reachable a[\s\S]*?WHERE f\.tenant_id = \?/.test(cte);

    expect(inBase, "missing in the base term").toBe(true);
    expect(inRecursive, "missing in the recursive term").toBe(true);
    expect(inFinal, "missing in the final select").toBe(true);
  });
});

describe("empty queries don't reach the database", () => {
  test("blank text", async () => {
    const { sql, queries } = spy();
    const search = createMemorySearch(sql);
    expect(await search.factsByText(TENANT, AGENT, "   ")).toEqual([]);
    expect(await search.entitiesByText(TENANT, "")).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  test("empty embedding", async () => {
    const { sql, queries } = spy();
    expect(await createMemorySearch(sql).factsByVector(TENANT, AGENT, [], MODEL)).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  test("no seeds", async () => {
    const { sql, queries } = spy();
    expect(await createMemorySearch(sql).factsByTraversal(TENANT, AGENT, [])).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});

describe("hybrid", () => {
  test("runs only the methods that have input", async () => {
    const { sql, queries } = spy();
    await createMemorySearch(sql).hybrid(TENANT, AGENT, { text: "project" });
    expect(queries).toHaveLength(1);
  });

  test("runs all three when there is input for all three", async () => {
    const { sql, queries } = spy();
    await createMemorySearch(sql).hybrid(TENANT, AGENT, {
      text: "project",
      embedding: [0.1],
      model: MODEL,
      seedEntityIds: [SEED],
    });
    expect(queries).toHaveLength(3);
  });

  test("with no input at all it doesn't query and returns empty", async () => {
    const { sql, queries } = spy();
    expect(await createMemorySearch(sql).hybrid(TENANT, AGENT, {})).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});
