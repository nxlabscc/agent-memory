/**
 * Hybrid search over the store.
 *
 * Three methods that look at different things: full-text catches words,
 * cosine catches semantics, and traversal catches context — what is close in
 * the graph shows up in similar contexts. They are fused with RRF, which
 * doesn't require their scores to be comparable with each other.
 *
 * The traversal is a recursive CTE; no graph engine is needed. And it's the
 * query where isolation is easiest to break without noticing: the tenant
 * filter has to be in the base term **and in the recursive one**. If it's
 * missing from the recursive term, from the second hop on the traversal wanders
 * into anyone's facts. It's not carelessness, it's the shape of the query —
 * that's why there's a test covering it against real Postgres.
 *
 * Facts also belong to an agent: each one sees only those that came out of its
 * own conversations. Entities don't —that something exists belongs to
 * everyone—, so the traversal can pass through an entity another agent named,
 * but the facts it walks and returns are always those of the agent asking.
 */

import { reciprocalRankFusion } from "./rerank";
import {
  DEFAULT_SCHEMA,
  guard,
  requireAgent,
  requireModel,
  requireTenant,
  tables,
  type Sql,
} from "./store";
import type { Entity, Fact, TenantId } from "./types";

interface FactRow {
  id: string;
  tenant_id: string;
  fact_embedding?: string | null;
  source_entity_id: string;
  target_entity_id: string;
  fact: string;
  created_at: Date;
  expired_at: Date | null;
  valid_at: Date | null;
  invalid_at: Date | null;
  episode_ids: string[] | null;
}

interface EntityRow {
  id: string;
  tenant_id: string;
  name: string;
  summary: string;
  attributes: Record<string, unknown>;
}

/** pgvector returns the vector as text: "[0.1,0.2,…]". */
function parseVector(value: string | null | undefined): number[] | null {
  if (typeof value !== "string" || value.length < 2) return null;
  return value.slice(1, -1).split(",").map(Number);
}

function toFact(row: FactRow): Fact {
  return {
    embedding: parseVector(row.fact_embedding),
    id: row.id,
    tenantId: row.tenant_id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    fact: row.fact,
    episodeIds: row.episode_ids ?? [],
    createdAt: row.created_at,
    expiredAt: row.expired_at,
    validAt: row.valid_at,
    invalidAt: row.invalid_at,
  };
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    summary: row.summary,
    attributes: row.attributes,
  };
}

/** pgvector takes the vector as a `[1,2,3]` literal. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export interface SearchOptions {
  limit?: number;
  /** Only facts valid at this point in world time. */
  at?: Date;
}

export interface TraversalOptions extends SearchOptions {
  /** Hops from the seed entities. */
  maxDepth?: number;
}

export interface MemorySearch {
  factsByText(
    tenantId: TenantId,
    agent: string,
    query: string,
    options?: SearchOptions,
  ): Promise<Fact[]>;

  /**
   * The facts closest to a vector, among those embedded with THAT model.
   *
   * `model` is required on purpose: comparing vectors from different models
   * returns a number that looks like a distance and isn't one.
   */
  factsByVector(
    tenantId: TenantId,
    agent: string,
    embedding: number[],
    model: string,
    options?: SearchOptions,
  ): Promise<Fact[]>;

  factsByTraversal(
    tenantId: TenantId,
    agent: string,
    seedEntityIds: string[],
    options?: TraversalOptions,
  ): Promise<Fact[]>;

  entitiesByText(
    tenantId: TenantId,
    query: string,
    options?: SearchOptions,
  ): Promise<Entity[]>;

  /** Runs the available methods and fuses them with RRF. */
  hybrid(
    tenantId: TenantId,
    agent: string,
    query: HybridQuery,
    options?: TraversalOptions,
  ): Promise<Fact[]>;
}

export interface HybridQuery {
  text?: string;
  embedding?: number[];
  /** Which model `embedding` comes from. Required if there is a vector. */
  model?: string;
  seedEntityIds?: string[];
}

export function createMemorySearch(sql: Sql, schema: string = DEFAULT_SCHEMA): MemorySearch {
  const T = tables(sql, schema);
  const search: MemorySearch = {
    async factsByText(tenantId, agent, query, options = {}) {
      const t = requireTenant(tenantId, "factsByText");
      const a = requireAgent(agent, "factsByText");
      if (query.trim().length === 0) return [];
      const limit = options.limit ?? 20;
      const at = options.at ?? null;

      const rows = await guard(sql, "factsByText")<FactRow>`
        SELECT f.id, f.tenant_id, f.source_entity_id, f.target_entity_id, f.fact,
               f.created_at, f.expired_at, f.valid_at, f.invalid_at, f.fact_embedding::text,
               array_agg(fe.episode_id) FILTER (WHERE fe.episode_id IS NOT NULL) AS episode_ids
        FROM ${T("facts")} f
        LEFT JOIN ${T("fact_episodes")} fe ON fe.fact_id = f.id
        WHERE f.tenant_id = ${t}
          AND f.agent = ${a}
          AND to_tsvector('simple', f.fact) @@ plainto_tsquery('simple', ${query})
          AND (${at}::timestamptz IS NULL
               OR ((f.valid_at IS NULL OR f.valid_at <= ${at})
               AND (f.invalid_at IS NULL OR f.invalid_at > ${at})))
        GROUP BY f.id
        ORDER BY ts_rank(to_tsvector('simple', f.fact),
                         plainto_tsquery('simple', ${query})) DESC
        LIMIT ${limit}
      `;
      return rows.map(toFact);
    },

    async factsByVector(tenantId, agent, embedding, model, options = {}) {
      const t = requireTenant(tenantId, "factsByVector");
      const a = requireAgent(agent, "factsByVector");
      const m = requireModel(model, "factsByVector");
      if (embedding.length === 0) return [];
      const limit = options.limit ?? 20;
      const at = options.at ?? null;
      const vector = toVectorLiteral(embedding);

      // No ANN index yet (the embedding dimension isn't settled): this is a
      // sequential scan. Correct but it doesn't scale — the index comes in a
      // later migration.
      const rows = await guard(sql, "factsByVector")<FactRow>`
        SELECT f.id, f.tenant_id, f.source_entity_id, f.target_entity_id, f.fact,
               f.created_at, f.expired_at, f.valid_at, f.invalid_at, f.fact_embedding::text,
               array_agg(fe.episode_id) FILTER (WHERE fe.episode_id IS NOT NULL) AS episode_ids
        FROM ${T("facts")} f
        LEFT JOIN ${T("fact_episodes")} fe ON fe.fact_id = f.id
        WHERE f.tenant_id = ${t}
          AND f.agent = ${a}
          AND f.fact_embedding IS NOT NULL
          -- The model filters like the tenant does: a fact embedded with another
          -- model can't be compared with this query, so it doesn't take part.
          AND f.embedding_model = ${m}
          AND (${at}::timestamptz IS NULL
               OR ((f.valid_at IS NULL OR f.valid_at <= ${at})
               AND (f.invalid_at IS NULL OR f.invalid_at > ${at})))
        GROUP BY f.id
        ORDER BY f.fact_embedding <=> ${vector}::vector
        LIMIT ${limit}
      `;
      return rows.map(toFact);
    },

    async factsByTraversal(tenantId, agent, seedEntityIds, options = {}) {
      const t = requireTenant(tenantId, "factsByTraversal");
      const a = requireAgent(agent, "factsByTraversal");
      if (seedEntityIds.length === 0) return [];
      const limit = options.limit ?? 20;
      const maxDepth = options.maxDepth ?? 2;
      const at = options.at ?? null;

      const rows = await guard(sql, "factsByTraversal")<FactRow>`
        WITH RECURSIVE reachable AS (
          SELECT e.id AS entity_id, 0 AS depth
          FROM ${T("entities")} e
          WHERE e.tenant_id = ${t} AND e.id = ANY(${seedEntityIds}::uuid[])

          UNION

          SELECT CASE WHEN f.source_entity_id = a.entity_id
                      THEN f.target_entity_id
                      ELSE f.source_entity_id END,
                 a.depth + 1
          FROM reachable a
          JOIN ${T("facts")} f
            -- The filter goes here too. Without it, from the second hop on
            -- the traversal crosses into another tenant's facts.
            ON f.tenant_id = ${t}
           AND f.agent = ${a}
           AND (f.source_entity_id = a.entity_id OR f.target_entity_id = a.entity_id)
          WHERE a.depth < ${maxDepth}
        )
        SELECT f.id, f.tenant_id, f.source_entity_id, f.target_entity_id, f.fact,
               f.created_at, f.expired_at, f.valid_at, f.invalid_at, f.fact_embedding::text,
               array_agg(fe.episode_id) FILTER (WHERE fe.episode_id IS NOT NULL) AS episode_ids
        FROM ${T("facts")} f
        JOIN reachable a
          ON a.entity_id IN (f.source_entity_id, f.target_entity_id)
        LEFT JOIN ${T("fact_episodes")} fe ON fe.fact_id = f.id
        WHERE f.tenant_id = ${t}
          AND f.agent = ${a}
          AND (${at}::timestamptz IS NULL
               OR ((f.valid_at IS NULL OR f.valid_at <= ${at})
               AND (f.invalid_at IS NULL OR f.invalid_at > ${at})))
        GROUP BY f.id
        LIMIT ${limit}
      `;
      return rows.map(toFact);
    },

    async entitiesByText(tenantId, query, options = {}) {
      const t = requireTenant(tenantId, "entitiesByText");
      if (query.trim().length === 0) return [];
      const limit = options.limit ?? 20;

      const rows = await guard(sql, "entitiesByText")<EntityRow>`
        SELECT id, tenant_id, name, summary, attributes
        FROM ${T("entities")}
        WHERE tenant_id = ${t}
          AND to_tsvector('simple', name || ' ' || summary)
              @@ plainto_tsquery('simple', ${query})
        ORDER BY ts_rank(to_tsvector('simple', name || ' ' || summary),
                         plainto_tsquery('simple', ${query})) DESC
        LIMIT ${limit}
      `;
      return rows.map(toEntity);
    },

    async hybrid(tenantId, agent, query, options = {}) {
      requireTenant(tenantId, "hybrid");
      requireAgent(agent, "hybrid");

      const rankings: Fact[][] = [];

      if (query.text) {
        rankings.push(await search.factsByText(tenantId, agent, query.text, options));
      }
      if (query.embedding && query.embedding.length > 0) {
        rankings.push(
          await search.factsByVector(
            tenantId,
            agent,
            query.embedding,
            requireModel(query.model, "hybrid"),
            options,
          ),
        );
      }
      if (query.seedEntityIds && query.seedEntityIds.length > 0) {
        rankings.push(
          await search.factsByTraversal(tenantId, agent, query.seedEntityIds, options),
        );
      }

      if (rankings.length === 0) return [];
      const fused = reciprocalRankFusion(rankings);
      return options.limit ? fused.slice(0, options.limit) : fused;
    },
  };

  return search;
}
