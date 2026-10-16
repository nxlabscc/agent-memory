-- Memory store.
--
-- It lives in its own schema, which may sit inside a Postgres database shared
-- with other components. It touches no tables outside that schema: this is the
-- module's own storage.
--
-- Tables are named fully qualified (`{{schema}}.x`) instead of relying on the
-- search_path. The store receives an injected client, and that client may be
-- configured for another schema — qualifying makes that irrelevant.
--
-- The `vector` extension is created here rather than assumed. Other components
-- sharing the database may create it too, and it is idempotent: several
-- components may need it and none can depend on another having started first.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS {{schema}};

-- Episodes: the unit of provenance. It is a pointer, not a copy.
-- The content lives in the client's transcript or data model. Here we store
-- the coordinate and a hash that makes it verifiable.
CREATE TABLE IF NOT EXISTS {{schema}}.episodes (
  id              UUID PRIMARY KEY,
  tenant_id       UUID        NOT NULL,
  kind            TEXT        NOT NULL CHECK (kind IN ('conversation', 'action', 'page')),
  -- Coordinate depending on kind. Conversation: session_id + message range.
  -- Action: the turn with the tool_use. Page: page_id + block range.
  source          JSONB       NOT NULL,
  content_sha256  TEXT        NOT NULL,
  valid_at        TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK target: nobody references an episode without naming its tenant.
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS episodes_tenant_idx
  ON {{schema}}.episodes (tenant_id, valid_at DESC);

-- Entities: named things.
CREATE TABLE IF NOT EXISTS {{schema}}.entities (
  id              UUID PRIMARY KEY,
  tenant_id       UUID        NOT NULL,
  name            TEXT        NOT NULL,
  -- Normalized name for the exact path of deterministic resolution.
  -- Computed by the application (dedup.ts), not the database: normalization
  -- includes rules we do not want to duplicate in SQL.
  normalized_name TEXT        NOT NULL,
  summary         TEXT        NOT NULL DEFAULT '',
  attributes      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- No dimension declared on purpose: the embedding provider was not chosen
  -- yet. The ANN index goes in a later migration, once the dimension is fixed.
  name_embedding  VECTOR,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Redundant for uniqueness (id is already the PK), but needed as the target
  -- of the facts' composite FK: it is what makes it impossible for a fact to
  -- point at another tenant's entity.
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS entities_tenant_name_idx
  ON {{schema}}.entities (tenant_id, normalized_name);

CREATE INDEX IF NOT EXISTS entities_fts_idx
  ON {{schema}}.entities USING GIN (
    to_tsvector('simple', name || ' ' || summary)
  );

-- Facts: a relation between two entities, with temporal validity.
--
-- Four timestamps, two independent axes:
--   created_at / expired_at  → system time: when we learned it
--   valid_at   / invalid_at  → world time:  when it was true
--
-- Nothing is deleted. A fact that stops being true closes its interval.
CREATE TABLE IF NOT EXISTS {{schema}}.facts (
  id                UUID PRIMARY KEY,
  tenant_id         UUID        NOT NULL,
  source_entity_id  UUID        NOT NULL,
  target_entity_id  UUID        NOT NULL,
  fact              TEXT        NOT NULL,
  fact_embedding    VECTOR,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expired_at        TIMESTAMPTZ,
  valid_at          TIMESTAMPTZ,
  invalid_at        TIMESTAMPTZ,

  -- Composite FK, not single-column: the reference includes the tenant. A fact
  -- cannot point at another tenant's entity, by mistake or on purpose, and so
  -- graph traversal has no way to cross over.
  FOREIGN KEY (tenant_id, source_entity_id)
    REFERENCES {{schema}}.entities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_entity_id)
    REFERENCES {{schema}}.entities (tenant_id, id) ON DELETE CASCADE,

  -- An interval that ends before it starts is a bug, not a state.
  CONSTRAINT facts_interval_ordered
    CHECK (valid_at IS NULL OR invalid_at IS NULL OR valid_at <= invalid_at),

  -- Composite FK target from the provenance table.
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS facts_tenant_idx
  ON {{schema}}.facts (tenant_id);

-- For "what held on August 5th": the valid ones first.
CREATE INDEX IF NOT EXISTS facts_validity_idx
  ON {{schema}}.facts (tenant_id, valid_at, invalid_at);

CREATE INDEX IF NOT EXISTS facts_entities_idx
  ON {{schema}}.facts (tenant_id, source_entity_id, target_entity_id);

CREATE INDEX IF NOT EXISTS facts_fts_idx
  ON {{schema}}.facts USING GIN (to_tsvector('simple', fact));

-- Provenance. It is N:M and grows: the same fact is extracted again from
-- several episodes, and that list is the citation set.
CREATE TABLE IF NOT EXISTS {{schema}}.fact_episodes (
  tenant_id   UUID NOT NULL,
  fact_id     UUID NOT NULL,
  episode_id  UUID NOT NULL,

  PRIMARY KEY (fact_id, episode_id),

  -- The tenant is repeated here so both references include it. It is the
  -- only way the link cannot join a fact with another tenant's episode:
  -- both FKs require the row's same tenant_id, so they have to match each
  -- other.
  FOREIGN KEY (tenant_id, fact_id)
    REFERENCES {{schema}}.facts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, episode_id)
    REFERENCES {{schema}}.episodes (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fact_episodes_by_episode_idx
  ON {{schema}}.fact_episodes (episode_id);

-- Incremental summaries over a range of episodes. A compaction primitive.
-- Double watermark: one in wall-clock time, to know where to resume
-- summarizing, and one in episode time, for temporal consumers.
CREATE TABLE IF NOT EXISTS {{schema}}.summaries (
  id                               UUID PRIMARY KEY,
  tenant_id                        UUID        NOT NULL,
  summary                          TEXT        NOT NULL,
  first_episode_id                 UUID,
  last_episode_id                  UUID,
  last_summarized_at               TIMESTAMPTZ NOT NULL,
  last_summarized_episode_valid_at TIMESTAMPTZ,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),

  FOREIGN KEY (tenant_id, first_episode_id)
    REFERENCES {{schema}}.episodes (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, last_episode_id)
    REFERENCES {{schema}}.episodes (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS summaries_tenant_idx
  ON {{schema}}.summaries (tenant_id, last_summarized_at DESC);

-- Structural index of the client's data model: structure, not content. It is
-- fed by a crawler over the client's semantic surface, not over CRUD.
--
-- `external_id` is the object's id in the client's data model. It references a
-- live object, so it is used as an optimistic hint with a fallback to
-- resolving by name: it can be renamed, moved or disappear.
CREATE TABLE IF NOT EXISTS {{schema}}.structural_index (
  id              UUID PRIMARY KEY,
  tenant_id       UUID        NOT NULL,
  kind            TEXT        NOT NULL CHECK (kind IN ('database', 'row', 'page')),
  external_id     TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  -- Schema and properties for a database or row. TOC and location for a
  -- prose page. Never the body.
  structure       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  content_sha256  TEXT,
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_id)
);

CREATE INDEX IF NOT EXISTS structural_index_tenant_kind_idx
  ON {{schema}}.structural_index (tenant_id, kind);

CREATE INDEX IF NOT EXISTS structural_index_fts_idx
  ON {{schema}}.structural_index USING GIN (to_tsvector('simple', title));
