-- What the agent decides to remember on its own.
--
-- It is neither a fact nor an entity: a fact comes from extracting a
-- conversation and has a subject, an object and a validity interval. This is
-- the agent writing something down in its own words because it will be useful
-- later, and it does not have that shape.
--
-- It lives alongside facts in the same search —embedded the same way and
-- fused into the same ranking— because from the recall side it makes no
-- difference where something useful came from.

CREATE TABLE IF NOT EXISTS {{schema}}.agent_notes (
  id         UUID PRIMARY KEY,
  tenant_id  UUID        NOT NULL,
  note       TEXT        NOT NULL,
  -- Which session it came from. Provenance, like the episodes of facts.
  session_id TEXT,
  embedding       VECTOR(768),
  embedding_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS agent_notes_tenant_idx
  ON {{schema}}.agent_notes (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_notes_fts_idx
  ON {{schema}}.agent_notes USING GIN (to_tsvector('simple', note));
