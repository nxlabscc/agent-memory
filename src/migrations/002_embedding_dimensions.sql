-- Fixes the vector length.
--
-- 001 left the columns as VECTOR without a dimension because it was not
-- decided. Without a fixed number two vectors are not comparable and cannot
-- be indexed.
--
-- 768, and it is our choice, not the provider's: both Gemini and OpenAI take
-- the length as a request parameter (`output_dimensionality` and
-- `dimensions`), so switching providers does not force a schema migration.
--
-- Why 768 and not 3072: pgvector indexes the `vector` type up to 2000
-- dimensions, so Gemini's default does not fit without switching to halfvec or
-- quantizing. And among the sizes that fit, Google's docs recommend 768 / 1536
-- / 3072 and report 67.99 MTEB at 768 against practically the same at 3072:
-- the truncation is Matryoshka, meaning 768 is not a mutilated 3072 but as
-- good as a model trained at 768.
--
-- The number also lives in EMBEDDING_DIMENSIONS, and a test checks that both
-- say the same.
--
-- Nothing writes embeddings yet, so the columns are empty and the ALTER has
-- nothing to convert.

ALTER TABLE {{schema}}.entities
  ALTER COLUMN name_embedding TYPE VECTOR(768);

ALTER TABLE {{schema}}.facts
  ALTER COLUMN fact_embedding TYPE VECTOR(768);

-- Which model produced each vector. Two providers' vectors are not comparable
-- even at the same length, so switching providers requires knowing which ones
-- to recompute.
ALTER TABLE {{schema}}.entities
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

ALTER TABLE {{schema}}.facts
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;
