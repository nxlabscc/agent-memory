/**
 * The agent's own memory.
 *
 * A fact comes from extracting a conversation: it has a subject, an object and
 * an interval during which it holds. This is something else — the agent
 * jotting something down in its own words because it will be useful later,
 * free of that structure and without claiming that someone said it.
 *
 * It is stored and searched just like a fact, and for the same reason: from
 * the retrieval side, what matters is that it's useful, not where it came from.
 *
 * It belongs to whoever wrote it: each agent reads only its own. A note is the
 * conclusion of someone with their own role and their own conversation.
 */

import {
  DEFAULT_SCHEMA,
  guard,
  requireAgent,
  requireModel,
  requireTenant,
  tables,
  type Sql,
} from "./store";
import type { TenantId } from "./types";

export interface AgentNote {
  id: string;
  tenantId: string;
  note: string;
  /** Who wrote it. */
  agent: string;
  sessionId: string | null;
  createdAt: Date;
  embedding?: number[] | null;
}

export interface NewNote {
  id: string;
  note: string;
  agent: string;
  sessionId?: string | null;
  embedding?: number[];
  embeddingModel?: string;
}

interface NoteRow {
  id: string;
  tenant_id: string;
  note: string;
  agent: string;
  session_id: string | null;
  created_at: Date;
  embedding?: string | null;
}

function parseVector(value: string | null | undefined): number[] | null {
  if (typeof value !== "string" || value.length < 2) return null;
  return value.slice(1, -1).split(",").map(Number);
}

function toNote(row: NoteRow): AgentNote {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    note: row.note,
    agent: row.agent,
    sessionId: row.session_id,
    createdAt: row.created_at,
    embedding: parseVector(row.embedding),
  };
}

const COLUMNS = "id, tenant_id, note, agent, session_id, created_at, embedding::text";

export interface AgentNotes {
  write(tenantId: TenantId, note: NewNote): Promise<void>;
  /** The agent's notes closest to a vector, among those written with THAT model. */
  byVector(tenantId: TenantId, agent: string, embedding: number[], model: string, limit?: number): Promise<AgentNote[]>;
  byText(tenantId: TenantId, agent: string, query: string, limit?: number): Promise<AgentNote[]>;
  recent(tenantId: TenantId, agent: string, limit?: number): Promise<AgentNote[]>;
}

export function createAgentNotes(sql: Sql, schema: string = DEFAULT_SCHEMA): AgentNotes {
  const T = tables(sql, schema);
  return {
    async write(tenantId, note) {
      const t = requireTenant(tenantId, "notes.write");
      const a = requireAgent(note.agent, "notes.write");
      await guard(sql, "notes.write")`
        INSERT INTO ${T("agent_notes")}
          (id, tenant_id, note, agent, session_id, embedding, embedding_model)
        VALUES (${note.id}, ${t}, ${note.note}, ${a}, ${note.sessionId ?? null},
                ${note.embedding ? `[${note.embedding.join(",")}]` : null},
                ${note.embeddingModel ?? null})
      `;
    },

    async byVector(tenantId, agent, embedding, model, limit = 10) {
      const t = requireTenant(tenantId, "notes.byVector");
      const a = requireAgent(agent, "notes.byVector");
      const m = requireModel(model, "notes.byVector");
      const rows = await guard(sql, "notes.byVector")<NoteRow>`
        SELECT ${sql.unsafe(COLUMNS)}
        FROM ${T("agent_notes")}
        WHERE tenant_id = ${t} AND agent = ${a} AND embedding IS NOT NULL AND embedding_model = ${m}
        ORDER BY embedding <=> ${`[${embedding.join(",")}]`}::vector
        LIMIT ${limit}
      `;
      return rows.map(toNote);
    },

    async byText(tenantId, agent, query, limit = 10) {
      const t = requireTenant(tenantId, "notes.byText");
      const a = requireAgent(agent, "notes.byText");
      if (query.trim().length === 0) return [];
      const rows = await guard(sql, "notes.byText")<NoteRow>`
        SELECT ${sql.unsafe(COLUMNS)}
        FROM ${T("agent_notes")}
        WHERE tenant_id = ${t} AND agent = ${a}
          AND to_tsvector('simple', note) @@ plainto_tsquery('simple', ${query})
        LIMIT ${limit}
      `;
      return rows.map(toNote);
    },

    async recent(tenantId, agent, limit = 20) {
      const t = requireTenant(tenantId, "notes.recent");
      const a = requireAgent(agent, "notes.recent");
      const rows = await guard(sql, "notes.recent")<NoteRow>`
        SELECT ${sql.unsafe(COLUMNS)}
        FROM ${T("agent_notes")}
        WHERE tenant_id = ${t} AND agent = ${a}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return rows.map(toNote);
    },
  };
}
