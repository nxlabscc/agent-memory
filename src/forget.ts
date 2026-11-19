/**
 * Forgetting what came out of a session that should not have happened.
 *
 * An episode is a pointer to a stretch of a session; when the client deletes
 * that session, what the memory kept from it points at nothing. This removes
 * it the way it went in: the session's notes, the episodes that point at it,
 * the facts that came only from those episodes, and the entities those facts
 * leave with no fact at all. A fact that also came from another episode stays,
 * because that other source still says it; only its link to the gone episode
 * goes. An entity that some other fact still names stays.
 *
 * This is a repair, not how facts end: a fact that stops being true is closed
 * with `invalid_at` and kept. Here the source itself is gone.
 *
 * Everything runs in one transaction. With `dryRun` it runs the same deletes
 * and rolls back, so what it reports is exactly what would go.
 */

import type { MigratingSql } from "./migrations";
import { guard, requireTenant, tables } from "./store";
import type { TenantId } from "./types";

/** What was taken out, or would be with `dryRun`. */
export interface Forgotten {
  notes: { id: string; agent: string; note: string }[];
  episodes: string[];
  facts: { id: string; agent: string; fact: string }[];
  entities: { id: string; name: string }[];
}

export interface ForgetOptions {
  /** Report what would go without removing anything. */
  dryRun?: boolean;
}

class Rollback extends Error {
  constructor(readonly result: Forgotten) {
    super("dry run");
  }
}

export async function forgetSessions(
  sql: MigratingSql,
  schema: string,
  tenantId: TenantId,
  sessionIds: string[],
  options: ForgetOptions = {},
): Promise<Forgotten> {
  const t = requireTenant(tenantId, "forgetSessions");
  if (sessionIds.length === 0) return { notes: [], episodes: [], facts: [], entities: [] };

  try {
    return await sql.begin(async (tx) => {
      const T = tables(tx, schema);
      const q = guard(tx, "forgetSessions");

      const notes = await q<{ id: string; agent: string; note: string }>`
        DELETE FROM ${T("agent_notes")}
        WHERE tenant_id = ${t} AND session_id = ANY(${sessionIds}::text[])
        RETURNING id, agent, note
      `;

      // The facts are read before the episodes go: deleting an episode takes
      // its links with it, and then there is no telling which facts it fed.
      const episodes = (await q<{ id: string }>`
        SELECT id FROM ${T("episodes")}
        WHERE tenant_id = ${t} AND source->>'sessionId' = ANY(${sessionIds}::text[])
      `).map((e) => e.id);
      const fed = (await q<{ fact_id: string }>`
        SELECT DISTINCT fact_id FROM ${T("fact_episodes")}
        WHERE tenant_id = ${t} AND episode_id = ANY(${episodes}::uuid[])
      `).map((f) => f.fact_id);

      await q`DELETE FROM ${T("episodes")} WHERE tenant_id = ${t} AND id = ANY(${episodes}::uuid[])`;

      const facts = await q<{ id: string; agent: string; fact: string; source_entity_id: string; target_entity_id: string }>`
        DELETE FROM ${T("facts")} f
        WHERE f.tenant_id = ${t} AND f.id = ANY(${fed}::uuid[])
          AND NOT EXISTS (SELECT 1 FROM ${T("fact_episodes")} fe WHERE fe.tenant_id = ${t} AND fe.fact_id = f.id)
        RETURNING id, agent, fact, source_entity_id, target_entity_id
      `;
      const ends = [...new Set(facts.flatMap((f) => [f.source_entity_id, f.target_entity_id]))];

      const entities = await q<{ id: string; name: string }>`
        DELETE FROM ${T("entities")} e
        WHERE e.tenant_id = ${t} AND e.id = ANY(${ends}::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM ${T("facts")} f
            WHERE f.tenant_id = ${t} AND (f.source_entity_id = e.id OR f.target_entity_id = e.id)
          )
        RETURNING id, name
      `;

      const result: Forgotten = {
        notes: notes.map(({ id, agent, note }) => ({ id, agent, note })),
        episodes,
        facts: facts.map(({ id, agent, fact }) => ({ id, agent, fact })),
        entities: entities.map(({ id, name }) => ({ id, name })),
      };
      if (options.dryRun) throw new Rollback(result);
      return result;
    });
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}
