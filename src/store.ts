/**
 * Store access layer.
 *
 * Tenant isolation lives here, and is made impossible to forget through three
 * paths at once:
 *
 *  1. **The signature demands it.** Every public operation takes `tenantId`
 *     first. Without it, it doesn't compile.
 *  2. **The runtime validates it.** An empty or non-string `tenantId` is
 *     rejected before touching the database, because at the API boundary the
 *     type is not enough.
 *  3. **The query mentions it.** Every statement goes through `guard`, which
 *     throws if the SQL does not reference `tenant_id`. A query that forgot the
 *     filter fails loudly instead of returning someone else's rows.
 *
 * The case that motivates point 3 is the write path, not the read path: the
 * entity resolver reads candidates **inside** a write path, and if that read
 * is not scoped it permanently merges entities from two tenants.
 */

import type { Entity, Episode, EpisodeSource, Fact, TenantId } from "./types";

/**
 * The `postgres` client as a tagged template, reduced to the bits we use.
 * It is injected: this module neither opens connections nor knows the config.
 */
export type Sql = (<T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>) & {
  /** Marks a value as JSON so the driver doesn't serialize it twice. */
  json: (value: unknown) => unknown;
  /** Literal SQL fragment, for fixed column lists. */
  unsafe: (fragment: string) => unknown;
};

export class TenantRequiredError extends Error {
  constructor(operation: string) {
    super(`${operation}: missing tenantId`);
    this.name = "TenantRequiredError";
  }
}

export class UnscopedQueryError extends Error {
  constructor(operation: string) {
    super(
      `${operation}: the query does not mention tenant_id. ` +
        `An unscoped query can return or merge another tenant's data.`,
    );
    this.name = "UnscopedQueryError";
  }
}

export class ModelRequiredError extends Error {
  constructor(operation: string) {
    super(
      `${operation}: missing the embedding model. ` +
        `A vector can only be compared with others from the same model.`,
    );
    this.name = "ModelRequiredError";
  }
}

/**
 * Rejects a vector search that doesn't say which model the vector comes from.
 *
 * Each model invents its own space: the cosine between a vector from one and
 * a vector from another is computed the same way and returns a plausible
 * number that means nothing. That's why the model is required just like the
 * tenant is — it isn't configuration, it's the condition for the comparison to
 * make sense.
 */
export function requireModel(model: string | null | undefined, operation: string): string {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ModelRequiredError(operation);
  }
  return model;
}

export class AgentRequiredError extends Error {
  constructor(operation: string) {
    super(`${operation}: missing the agent. Each agent sees only its own memory.`);
    this.name = "AgentRequiredError";
  }
}

/**
 * Rejects a read or write of an agent's own memory that doesn't say which
 * agent it belongs to.
 *
 * Facts and notes belong to whoever heard or wrote them: without the agent,
 * the query would return everyone's, which is exactly what the partition
 * prevents.
 */
export function requireAgent(agent: string | null | undefined, operation: string): string {
  if (typeof agent !== "string" || agent.trim().length === 0) {
    throw new AgentRequiredError(operation);
  }
  return agent;
}

/** Rejects a missing tenant before reaching the database. */
export function requireTenant(
  tenantId: TenantId | null | undefined,
  operation: string,
): TenantId {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new TenantRequiredError(operation);
  }
  return tenantId;
}

/** The Postgres schema where memory lives if whoever opens it doesn't pick another. */
export const DEFAULT_SCHEMA = "memory";

export class InvalidSchemaError extends Error {
  constructor(schema: string) {
    super(`invalid schema: ${JSON.stringify(schema)}. Only lowercase letters, digits and _.`);
    this.name = "InvalidSchemaError";
  }
}

/**
 * Rejects a schema name that is not a simple identifier.
 *
 * The name is pasted into the SQL text —an identifier can't travel as a
 * parameter—, so anything other than letters, digits and `_` is not allowed.
 */
export function requireSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new InvalidSchemaError(schema);
  return schema;
}

/**
 * A schema's tables, as SQL fragments.
 *
 * Each call builds the fragment again: it's literal text (`schema.table`) that
 * the driver pastes as is, and the name has already gone through
 * `requireSchema`.
 */
export function tables(sql: Sql, schema: string): (table: string) => unknown {
  const s = requireSchema(schema);
  return (table) => sql.unsafe(`${s}.${table}`);
}

/**
 * Wraps the client so that no statement can go out without `tenant_id`.
 *
 * The check is on the SQL text, which is what can be verified without a
 * database in front — and for that very reason it can be tested in CI.
 */
export function guard(sql: Sql, operation: string): Sql {
  return (<T,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join("?").includes("tenant_id")) {
      throw new UnscopedQueryError(operation);
    }
    return sql<T>(strings, ...values);
  }) as Sql;
}

// ─── Rows ────────────────────────────────────────────────────────────────────

interface EpisodeRow {
  id: string;
  tenant_id: string;
  kind: Episode["source"]["kind"];
  source: Record<string, unknown> | string;
  content_sha256: string;
  valid_at: Date;
  created_at: Date;
}

interface EntityRow {
  id: string;
  tenant_id: string;
  name: string;
  summary: string;
  attributes: Record<string, unknown>;
}

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

/**
 * `source` may come back as an object or as a JSON string.
 *
 * Old rows were written with the JSON already serialized plus a cast, which
 * stored it as a string INSIDE the jsonb instead of as an object: when read
 * back, spreading a string yields none of its keys and the pointer to the
 * original text ended up empty. The write was fixed; this is for the rows that
 * already exist.
 */
function parseSource(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return (value ?? {}) as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    source: { kind: row.kind, ...parseSource(row.source) } as EpisodeSource,
    contentSha256: row.content_sha256,
    validAt: row.valid_at,
    createdAt: row.created_at,
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

// ─── Store ───────────────────────────────────────────────────────────────────

export interface NewEpisode {
  id: string;
  source: EpisodeSource;
  contentSha256: string;
  validAt: Date;
}

export interface NewEntity {
  id: string;
  name: string;
  normalizedName: string;
  summary?: string;
  attributes?: Record<string, unknown>;
}

export interface NewFact {
  id: string;
  /** The agent of the conversation it came from: the fact is theirs and no one else's. */
  agent: string;
  sourceEntityId: string;
  targetEntityId: string;
  fact: string;
  validAt: Date | null;
  invalidAt?: Date | null;
  episodeIds: string[];
  /** The statement's vector, if there is a provider. */
  embedding?: number[];
  /** Which model produced it. Two providers are not comparable with each other. */
  embeddingModel?: string;
}

export interface MemoryStore {
  insertEpisode(tenantId: TenantId, episode: NewEpisode): Promise<void>;
  getEpisodes(tenantId: TenantId, ids: string[]): Promise<Episode[]>;

  insertEntity(tenantId: TenantId, entity: NewEntity): Promise<void>;
  /** Candidates for deterministic resolution. **Always** scoped. */
  candidateEntities(tenantId: TenantId, limit?: number): Promise<Entity[]>;

  insertFact(tenantId: TenantId, fact: NewFact): Promise<void>;
  /**
   * An agent's currently valid facts between two entities. Candidate generator
   * for deciding whether a new fact repeats or contradicts an existing one:
   * what another agent knows is neither repeated nor contradicted by this.
   */
  factsBetween(
    tenantId: TenantId,
    agent: string,
    sourceEntityId: string,
    targetEntityId: string,
    at: Date,
  ): Promise<Fact[]>;
  /**
   * Adds an episode to the provenance of a fact that already exists. This is
   * what happens when something is said again: the fact is one and the sources
   * accumulate.
   */
  linkEpisode(tenantId: TenantId, factId: string, episodeId: string): Promise<void>;
  /** An agent's facts valid at a given point in world time. */
  factsValidAt(tenantId: TenantId, agent: string, at: Date): Promise<Fact[]>;
  /** Closes a fact's interval. Never deletes. */
  invalidateFact(
    tenantId: TenantId,
    factId: string,
    invalidAt: Date,
    now: Date,
  ): Promise<void>;
}

export function createMemoryStore(sql: Sql, schema: string = DEFAULT_SCHEMA): MemoryStore {
  const T = tables(sql, schema);
  return {
    async insertEpisode(tenantId, episode) {
      const t = requireTenant(tenantId, "insertEpisode");
      const { kind, ...source } = episode.source;
      await guard(sql, "insertEpisode")`
        INSERT INTO ${T("episodes")} (id, tenant_id, kind, source, content_sha256, valid_at)
        VALUES (${episode.id}, ${t}, ${kind}, ${sql.json(source)},
                ${episode.contentSha256}, ${episode.validAt})
      `;
    },

    async getEpisodes(tenantId, ids) {
      const t = requireTenant(tenantId, "getEpisodes");
      if (ids.length === 0) return [];
      const rows = await guard(sql, "getEpisodes")<EpisodeRow>`
        SELECT id, tenant_id, kind, source, content_sha256, valid_at, created_at
        FROM ${T("episodes")}
        WHERE tenant_id = ${t} AND id = ANY(${ids}::uuid[])
      `;
      return rows.map(toEpisode);
    },

    async insertEntity(tenantId, entity) {
      const t = requireTenant(tenantId, "insertEntity");
      await guard(sql, "insertEntity")`
        INSERT INTO ${T("entities")} (id, tenant_id, name, normalized_name, summary, attributes)
        VALUES (${entity.id}, ${t}, ${entity.name}, ${entity.normalizedName},
                ${entity.summary ?? ""}, ${JSON.stringify(entity.attributes ?? {})}::jsonb)
      `;
    },

    async candidateEntities(tenantId, limit = 1000) {
      const t = requireTenant(tenantId, "candidateEntities");
      const rows = await guard(sql, "candidateEntities")<EntityRow>`
        SELECT id, tenant_id, name, summary, attributes
        FROM ${T("entities")}
        WHERE tenant_id = ${t}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return rows.map(toEntity);
    },

    async insertFact(tenantId, fact) {
      const t = requireTenant(tenantId, "insertFact");
      const a = requireAgent(fact.agent, "insertFact");
      await guard(sql, "insertFact")`
        INSERT INTO ${T("facts")}
          (id, tenant_id, agent, source_entity_id, target_entity_id, fact, valid_at, invalid_at,
           fact_embedding, embedding_model)
        VALUES (${fact.id}, ${t}, ${a}, ${fact.sourceEntityId}, ${fact.targetEntityId},
                ${fact.fact}, ${fact.validAt}, ${fact.invalidAt ?? null},
                ${fact.embedding ? `[${fact.embedding.join(",")}]` : null},
                ${fact.embeddingModel ?? null})
      `;

      if (fact.episodeIds.length === 0) return;

      // The provenance table carries its own tenant_id and both FKs are
      // composite, so linking to someone else's episode or a nonexistent one
      // doesn't "do nothing": the database rejects it. A wrong id is a bug in
      // the extractor and it has to hurt.
      await guard(sql, "insertFact:provenance")`
        INSERT INTO ${T("fact_episodes")} (tenant_id, fact_id, episode_id)
        SELECT ${t}, ${fact.id}, unnest(${fact.episodeIds}::uuid[])
        ON CONFLICT DO NOTHING
      `;
    },

    async factsBetween(tenantId, agent, sourceEntityId, targetEntityId, at) {
      const t = requireTenant(tenantId, "factsBetween");
      const a = requireAgent(agent, "factsBetween");
      const rows = await guard(sql, "factsBetween")<FactRow>`
        SELECT f.id, f.tenant_id, f.source_entity_id, f.target_entity_id, f.fact,
               f.created_at, f.expired_at, f.valid_at, f.invalid_at, f.fact_embedding::text,
               array_agg(fe.episode_id) FILTER (WHERE fe.episode_id IS NOT NULL) AS episode_ids
        FROM ${T("facts")} f
        LEFT JOIN ${T("fact_episodes")} fe ON fe.fact_id = f.id AND fe.tenant_id = f.tenant_id
        WHERE f.tenant_id = ${t}
          AND f.agent = ${a}
          AND f.source_entity_id = ${sourceEntityId}
          AND f.target_entity_id = ${targetEntityId}
          AND (f.valid_at   IS NULL OR f.valid_at   <= ${at})
          AND (f.invalid_at IS NULL OR f.invalid_at >  ${at})
        GROUP BY f.id
      `;
      return rows.map(toFact);
    },

    async linkEpisode(tenantId, factId, episodeId) {
      const t = requireTenant(tenantId, "linkEpisode");
      await guard(sql, "linkEpisode")`
        INSERT INTO ${T("fact_episodes")} (tenant_id, fact_id, episode_id)
        VALUES (${t}, ${factId}, ${episodeId})
        ON CONFLICT DO NOTHING
      `;
    },

    async factsValidAt(tenantId, agent, at) {
      const t = requireTenant(tenantId, "factsValidAt");
      const a = requireAgent(agent, "factsValidAt");
      const rows = await guard(sql, "factsValidAt")<FactRow>`
        SELECT f.id, f.tenant_id, f.source_entity_id, f.target_entity_id, f.fact,
               f.created_at, f.expired_at, f.valid_at, f.invalid_at,
               array_agg(fe.episode_id) FILTER (WHERE fe.episode_id IS NOT NULL) AS episode_ids
        FROM ${T("facts")} f
        LEFT JOIN ${T("fact_episodes")} fe ON fe.fact_id = f.id
        WHERE f.tenant_id = ${t}
          AND f.agent = ${a}
          AND (f.valid_at   IS NULL OR f.valid_at   <= ${at})
          AND (f.invalid_at IS NULL OR f.invalid_at >  ${at})
        GROUP BY f.id
      `;
      return rows.map(toFact);
    },

    async invalidateFact(tenantId, factId, invalidAt, now) {
      const t = requireTenant(tenantId, "invalidateFact");
      await guard(sql, "invalidateFact")`
        UPDATE ${T("facts")}
        SET invalid_at = ${invalidAt},
            expired_at = COALESCE(expired_at, ${now})
        WHERE id = ${factId} AND tenant_id = ${t}
      `;
    },
  };
}
