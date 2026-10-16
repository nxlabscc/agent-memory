-- Who wrote each note.
--
-- The system is multi-agent and the memory belongs to the tenant, so without
-- this what one agent wrote down another reads as its own. And they are not
-- the same: a note is the conclusion of whoever wrote it, and another agent may
-- have another role and other information.
--
-- Existing notes are left without an author, which is what we know about them.

ALTER TABLE {{schema}}.agent_notes ADD COLUMN IF NOT EXISTS agent TEXT;

CREATE INDEX IF NOT EXISTS agent_notes_agent_idx
  ON {{schema}}.agent_notes (tenant_id, agent);
