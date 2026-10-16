-- A person's memory is partitioned by agent.
--
-- Each agent remembers what it talked about and what it did: a fact belongs to
-- whoever heard it, and a note to whoever wrote it. What belongs to everyone is
-- the entities —that something exists— and the index of the workspace's
-- documents.
--
-- Rows written before this migration have no agent. On a database that
-- already holds such rows, the SET NOT NULL below fails until they are
-- assigned one.

ALTER TABLE {{schema}}.facts ADD COLUMN IF NOT EXISTS agent TEXT;

ALTER TABLE {{schema}}.facts ALTER COLUMN agent SET NOT NULL;

CREATE INDEX IF NOT EXISTS facts_agent_idx ON {{schema}}.facts (tenant_id, agent);

ALTER TABLE {{schema}}.agent_notes ALTER COLUMN agent SET NOT NULL;
