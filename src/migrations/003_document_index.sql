-- Document index: what is in the workspace, not what it says.
--
-- Replaces structural_index, which was never used. The name matters: what gets
-- indexed are documents —pages—, and a row of a database IS a page too. There
-- are not two kinds of things.
--
-- What it stores is the encyclopedia's index, not the encyclopedia: title,
-- outline and location. The body is fetched from the client when needed.
--
-- And it is not a source of truth about what exists: it may say a page is
-- there after it was deleted. It serves for recall and ranking. To assert that
-- something exists now, ask the system that owns the documents.

DROP TABLE IF EXISTS {{schema}}.structural_index;

CREATE TABLE IF NOT EXISTS {{schema}}.document_index (
  id            UUID PRIMARY KEY,
  tenant_id     UUID        NOT NULL,
  -- The page's id in the data model. It is the reference the agent uses to
  -- fetch it, and the key the crawler updates it by.
  page_id       TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  -- Where it lives: the page that contains it, or the database it is a row of.
  parent_id     TEXT,
  database_id   TEXT,
  -- The headings. Empty for most rows, which have no body.
  toc           TEXT        NOT NULL DEFAULT '',
  -- Properties and relations, if it is a row. They come in the same read as
  -- the title, so indexing them costs no extra call.
  properties    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Views with their name and id, if the page presents a database. It is what
  -- turns "it exists" into "and this is how to read it".
  views         JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Title + TOC are embedded. Properties are not: their values change all the
  -- time and pollute matching, but they are what is returned once found.
  embedding       VECTOR(768),
  embedding_model TEXT,

  -- The page's `updated_at` in the data model. It is the mark against which
  -- the crawler decides whether it needs to read it again.
  source_updated_at TIMESTAMPTZ,
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, page_id)
);

CREATE INDEX IF NOT EXISTS document_index_tenant_idx
  ON {{schema}}.document_index (tenant_id, source_updated_at DESC);

CREATE INDEX IF NOT EXISTS document_index_fts_idx
  ON {{schema}}.document_index USING GIN (to_tsvector('simple', title || ' ' || toc));
