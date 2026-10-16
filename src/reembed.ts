/**
 * Recompute the vectors when the model changes.
 *
 * A vector can only be compared with others from the same model, so search
 * filters by model and whatever was left with the old one stops showing up.
 * This module is the other half: it moves it to the new model.
 *
 * It's possible because **the text is stored next to the vector** — the fact,
 * the title with its outline, the note—: recomputing is closed over the
 * database itself, without going back to the original source or rereading a
 * conversation.
 *
 * Three properties, all by construction rather than by care:
 *
 * - **Resumable**: what's pending is `embedding_model <> the current one`, so
 *   the progress marker is the data itself. If the process dies, the next run
 *   finds exactly what's left.
 * - **Never half-done**: each row is updated with its vector and its model in
 *   the same statement. A row is entirely on one model or entirely on the
 *   other.
 * - **Cheap when nothing changed**: if the model is the same, the first query
 *   returns no rows and it ends there.
 */

import type { EmbeddingProvider } from "./embedding";
import { documentEmbeddingText } from "./documents";
import { DEFAULT_SCHEMA, guard, requireModel, requireTenant, tables, type Sql } from "./store";
import type { TenantId } from "./types";

/** What was recomputed in a run. */
export interface ReembedReport {
  facts: number;
  documents: number;
  notes: number;
}

export interface ReembedOptions {
  /** How many rows per round. The provider bills and rate-limits per call. */
  batchSize?: number;
  /** Stops the run (a shutdown, a test). */
  signal?: AbortSignal;
  /** Called when a batch has been saved, so progress can be watched from outside. */
  onProgress?: (report: ReembedReport) => void;
  /** Which schema the memory lives in. */
  schema?: string;
}

/** The tenants that have something embedded with another model. */
export async function tenantsWithStaleEmbeddings(
  sql: Sql,
  model: string,
  schema: string = DEFAULT_SCHEMA,
): Promise<string[]> {
  const m = requireModel(model, "tenantsWithStaleEmbeddings");
  const T = tables(sql, schema);
  const rows = await sql<{ tenant_id: string }>`
    SELECT tenant_id FROM ${T("facts")}
      WHERE fact_embedding IS NOT NULL AND embedding_model IS DISTINCT FROM ${m}
    UNION
    SELECT tenant_id FROM ${T("document_index")}
      WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM ${m}
    UNION
    SELECT tenant_id FROM ${T("agent_notes")}
      WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM ${m}
  `;
  return rows.map((r) => r.tenant_id);
}

/**
 * Moves everything this tenant has on another model to `embedder`'s model.
 *
 * Returns how many rows were touched. Calling it again with nothing pending
 * returns zeros and doesn't spend a single call to the provider.
 */
export async function reembedTenant(
  sql: Sql,
  tenantId: TenantId,
  embedder: EmbeddingProvider,
  options: ReembedOptions = {},
): Promise<ReembedReport> {
  const t = requireTenant(tenantId, "reembedTenant");
  const m = requireModel(embedder.name, "reembedTenant");
  const T = tables(sql, options.schema ?? DEFAULT_SCHEMA);
  const batch = options.batchSize ?? 50;
  const total: ReembedReport = { facts: 0, documents: 0, notes: 0 };

  const aborted = () => options.signal?.aborted === true;

  // --- facts --------------------------------------------------------------------------------
  while (!aborted()) {
    const rows = await guard(sql, "reembed.facts")<{ id: string; fact: string }>`
      SELECT id, fact FROM ${T("facts")}
      WHERE tenant_id = ${t} AND fact_embedding IS NOT NULL AND embedding_model IS DISTINCT FROM ${m}
      LIMIT ${batch}
    `;
    if (rows.length === 0) break;
    const vectors = await embedder.embedBatch(rows.map((f) => f.fact));
    for (const [i, row] of rows.entries()) {
      await guard(sql, "reembed.facts.update")`
        UPDATE ${T("facts")}
        SET fact_embedding = ${`[${vectors[i]!.join(",")}]`}::vector, embedding_model = ${m}
        WHERE tenant_id = ${t} AND id = ${row.id}
      `;
    }
    total.facts += rows.length;
    options.onProgress?.({ ...total });
  }

  // --- indexed documents --------------------------------------------------------------------
  while (!aborted()) {
    const rows = await guard(sql, "reembed.documents")<{ external_id: string; title: string; toc: string }>`
      SELECT external_id, title, toc FROM ${T("document_index")}
      WHERE tenant_id = ${t} AND embedding IS NOT NULL AND embedding_model IS DISTINCT FROM ${m}
      LIMIT ${batch}
    `;
    if (rows.length === 0) break;
    const vectors = await embedder.embedBatch(
      rows.map((d) => documentEmbeddingText(d.title, d.toc)),
    );
    for (const [i, row] of rows.entries()) {
      await guard(sql, "reembed.documents.update")`
        UPDATE ${T("document_index")}
        SET embedding = ${`[${vectors[i]!.join(",")}]`}::vector, embedding_model = ${m}
        WHERE tenant_id = ${t} AND external_id = ${row.external_id}
      `;
    }
    total.documents += rows.length;
    options.onProgress?.({ ...total });
  }

  // --- agent notes --------------------------------------------------------------------------
  while (!aborted()) {
    const rows = await guard(sql, "reembed.notes")<{ id: string; note: string }>`
      SELECT id, note FROM ${T("agent_notes")}
      WHERE tenant_id = ${t} AND embedding IS NOT NULL AND embedding_model IS DISTINCT FROM ${m}
      LIMIT ${batch}
    `;
    if (rows.length === 0) break;
    const vectors = await embedder.embedBatch(rows.map((n) => n.note));
    for (const [i, row] of rows.entries()) {
      await guard(sql, "reembed.notes.update")`
        UPDATE ${T("agent_notes")}
        SET embedding = ${`[${vectors[i]!.join(",")}]`}::vector, embedding_model = ${m}
        WHERE tenant_id = ${t} AND id = ${row.id}
      `;
    }
    total.notes += rows.length;
    options.onProgress?.({ ...total });
  }

  return total;
}
