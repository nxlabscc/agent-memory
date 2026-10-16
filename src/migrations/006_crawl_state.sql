-- When the crawler last ran, per tenant.
--
-- It is process state, not data state: the next run asks for what changed
-- after this date. Deriving it from the index —the newest row seen so far—
-- looks equivalent but is not: a tenant without any page would have no mark,
-- and the mark would be set by the data instead of the process.

CREATE TABLE IF NOT EXISTS {{schema}}.crawl_state (
  tenant_id   UUID PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL
);
