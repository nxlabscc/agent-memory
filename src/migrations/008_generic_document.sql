-- The index document stops being tied to one client's page model.
--
-- The only columns left are the ones the memory uses: the id in the system it
-- comes from, the title and the outline, which are what gets embedded and
-- searched. Where it lives, its properties and its views belong to the client:
-- they move to `extra`, which the memory stores and returns without reading.
--
-- And the crawler state moves out of here. When it last ran is bookkeeping for
-- whoever walks the documents, not memory data.

ALTER TABLE {{schema}}.document_index
  ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE {{schema}}.document_index
SET extra = jsonb_strip_nulls(jsonb_build_object(
  'parentId',   parent_id,
  'databaseId', database_id,
  'properties', properties,
  'views',      views
));

ALTER TABLE {{schema}}.document_index
  DROP COLUMN IF EXISTS parent_id,
  DROP COLUMN IF EXISTS database_id,
  DROP COLUMN IF EXISTS properties,
  DROP COLUMN IF EXISTS views;

ALTER TABLE {{schema}}.document_index RENAME COLUMN page_id TO external_id;

DROP TABLE IF EXISTS {{schema}}.crawl_state;
