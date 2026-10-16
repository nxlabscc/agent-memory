/**
 * The document index: what exists and how to get to it.
 *
 * It stores pointers, never bodies. Per document: its id in the system it
 * comes from, its title and its outline. It's the encyclopedia's index, and
 * what a search returns is a pointer: with that id the client goes and reads
 * the actual document.
 *
 * Title + outline is what gets embedded, and it's the only thing the memory
 * interprets. Anything else the client wants at hand when it finds the
 * document —where it lives, its properties, how to navigate it— goes in
 * `extra`: the memory stores it and returns it as is, and it enters neither
 * the vector nor the search.
 *
 * It is a recall and ranking aid; the source of truth about what exists is the
 * system the documents come from. It may still list a document that has
 * already been deleted.
 */

import {
  DEFAULT_SCHEMA,
  guard,
  requireModel,
  requireTenant,
  tables,
  type Sql,
} from "./store";
import type { TenantId } from "./types";

/** A document as the index sees it. */
export interface IndexedDocument {
  id: string;
  tenantId: string;
  /** The document's id in the system it comes from: this is what you fetch it with. */
  externalId: string;
  title: string;
  toc: string;
  /** What the client stored alongside the document. The memory doesn't read it. */
  extra: Record<string, unknown>;
  sourceUpdatedAt: Date | null;
}

/** What the client hands over for indexing. */
export interface NewDocument {
  externalId: string;
  title: string;
  toc?: string;
  extra?: Record<string, unknown>;
  /** When it changed in the system it comes from. */
  sourceUpdatedAt?: Date | null;
}

/** What gets written: the document with its id and, if there is a provider, its vector. */
export interface DocumentRecord extends NewDocument {
  id: string;
  embedding?: number[];
  embeddingModel?: string;
}

interface DocumentRow {
  id: string;
  tenant_id: string;
  external_id: string;
  title: string;
  toc: string;
  extra: Record<string, unknown> | string;
  source_updated_at: Date | null;
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toDocument(row: DocumentRow): IndexedDocument {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    externalId: row.external_id,
    title: row.title,
    toc: row.toc,
    extra: parseJson(row.extra, {}),
    sourceUpdatedAt: row.source_updated_at,
  };
}

const COLUMNS = `id, tenant_id, external_id, title, toc, extra, source_updated_at`;

export interface DocumentIndex {
  /**
   * Writes or overwrites a document's entry.
   *
   * The client comes back to the same document every time it changes, so the
   * natural operation is to replace, not to accumulate.
   */
  upsert(tenantId: TenantId, doc: DocumentRecord): Promise<void>;
  /** The date of the newest thing indexed. */
  lastIndexedAt(tenantId: TenantId): Promise<Date | null>;
  /** Everything indexed for the tenant, by title. */
  list(tenantId: TenantId): Promise<IndexedDocument[]>;
  /**
   * The documents closest to a vector, among those indexed with THAT model.
   * The model filters like the tenant does.
   */
  byVector(tenantId: TenantId, embedding: number[], model: string, limit?: number): Promise<IndexedDocument[]>;
  byText(tenantId: TenantId, query: string, limit?: number): Promise<IndexedDocument[]>;
  /** Removes from the index what no longer exists. It is the only deletion path. */
  forget(tenantId: TenantId, externalIds: string[]): Promise<void>;
}

export function createDocumentIndex(sql: Sql, schema: string = DEFAULT_SCHEMA): DocumentIndex {
  const T = tables(sql, schema);
  return {
    async upsert(tenantId, doc) {
      const t = requireTenant(tenantId, "documents.upsert");
      await guard(sql, "documents.upsert")`
        INSERT INTO ${T("document_index")}
          (id, tenant_id, external_id, title, toc, extra,
           embedding, embedding_model, source_updated_at, indexed_at)
        VALUES (${doc.id}, ${t}, ${doc.externalId}, ${doc.title}, ${doc.toc ?? ""},
                ${sql.json(doc.extra ?? {})},
                ${doc.embedding ? `[${doc.embedding.join(",")}]` : null},
                ${doc.embeddingModel ?? null}, ${doc.sourceUpdatedAt ?? null}, now())
        ON CONFLICT (tenant_id, external_id) DO UPDATE SET
          title             = excluded.title,
          toc               = excluded.toc,
          extra             = excluded.extra,
          embedding         = excluded.embedding,
          embedding_model   = excluded.embedding_model,
          source_updated_at = excluded.source_updated_at,
          indexed_at        = now()
      `;
    },

    async lastIndexedAt(tenantId) {
      const t = requireTenant(tenantId, "documents.lastIndexedAt");
      const [row] = await guard(sql, "documents.lastIndexedAt")<{ latest: Date | null }>`
        SELECT max(source_updated_at) AS latest
        FROM ${T("document_index")} WHERE tenant_id = ${t}
      `;
      return row?.latest ?? null;
    },

    async list(tenantId) {
      const t = requireTenant(tenantId, "documents.list");
      const rows = await guard(sql, "documents.list")<DocumentRow>`
        SELECT ${sql.unsafe(COLUMNS)}
        FROM ${T("document_index")}
        WHERE tenant_id = ${t}
        ORDER BY title
      `;
      return rows.map(toDocument);
    },

    async byVector(tenantId, embedding, model, limit = 10) {
      const t = requireTenant(tenantId, "documents.byVector");
      const m = requireModel(model, "documents.byVector");
      const rows = await guard(sql, "documents.byVector")<DocumentRow>`
        SELECT ${sql.unsafe(COLUMNS)}
        FROM ${T("document_index")}
        WHERE tenant_id = ${t} AND embedding IS NOT NULL AND embedding_model = ${m}
        ORDER BY embedding <=> ${`[${embedding.join(",")}]`}::vector
        LIMIT ${limit}
      `;
      return rows.map(toDocument);
    },

    async byText(tenantId, query, limit = 10) {
      const t = requireTenant(tenantId, "documents.byText");
      if (query.trim().length === 0) return [];
      const rows = await guard(sql, "documents.byText")<DocumentRow>`
        SELECT ${sql.unsafe(COLUMNS)}
        FROM ${T("document_index")}
        WHERE tenant_id = ${t}
          AND to_tsvector('simple', title || ' ' || toc)
              @@ plainto_tsquery('simple', ${query})
        LIMIT ${limit}
      `;
      return rows.map(toDocument);
    },

    async forget(tenantId, externalIds) {
      const t = requireTenant(tenantId, "documents.forget");
      if (externalIds.length === 0) return;
      await guard(sql, "documents.forget")`
        DELETE FROM ${T("document_index")}
        WHERE tenant_id = ${t} AND external_id = ANY(${externalIds}::text[])
      `;
    },
  };
}

/**
 * The text that gets embedded: title and outline, nothing else.
 *
 * Kept separate so it's obvious what goes into the vector and what doesn't, and
 * so it can be tested without a database.
 */
export function documentEmbeddingText(title: string, toc: string): string {
  return toc.trim().length === 0 ? title : `${title}\n${toc}`;
}
