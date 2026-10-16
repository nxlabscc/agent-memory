/**
 * Memory domain types.
 */

/** Every operation carries the tenant. Without it no call is possible. */
export type TenantId = string;

// ─── Episode ─────────────────────────────────────────────────────────────────

/**
 * Where an episode came from. The episode is a pointer, never a copy: the
 * client's transcript and data model remain the owners of the content.
 */
export type EpisodeSource =
  | {
      kind: "conversation";
      sessionId: string;
      messageIdFrom: string;
      messageIdTo: string;
    }
  | {
      kind: "action";
      sessionId: string;
      /** The turn that contains the tool_use / tool_result. */
      messageId: string;
    }
  | {
      kind: "page";
      pageId: string;
      blockFrom: number;
      blockTo: number;
    };

/**
 * The unit of provenance: the chunk that was sent for extraction.
 *
 * `contentSha256` is what separates a valid citation from one that only looks
 * valid — if the transcript changed or the page was edited, it is detected
 * instead of confidently serving stale text.
 */
export interface Episode {
  id: string;
  tenantId: TenantId;
  source: EpisodeSource;
  contentSha256: string;
  /** When it happened (world time). */
  validAt: Date;
  createdAt: Date;
}

// ─── Entity ──────────────────────────────────────────────────────────────────

export interface Entity {
  id: string;
  tenantId: TenantId;
  name: string;
  summary: string;
  attributes: Record<string, unknown>;
}

// ─── Fact ────────────────────────────────────────────────────────────────────

/**
 * The unit that gets recalled: a relation between two entities, with temporal
 * validity.
 *
 * The two axes are independent and both are needed:
 *
 * - `createdAt` / `expiredAt` — **system** time: when we learned it, when we
 *   stopped believing it.
 * - `validAt` / `invalidAt` — **world** time: when it was true.
 *
 * A fact is never deleted. When it stops being true, its interval closes.
 */
export interface Fact {
  /** The statement's vector, if it was computed. */
  embedding?: number[] | null;
  id: string;
  tenantId: TenantId;
  sourceEntityId: string;
  targetEntityId: string;
  /** The statement, as text. It is what gets embedded and what gets rendered. */
  fact: string;

  /** Provenance. Plural: it grows when the same fact is extracted again. */
  episodeIds: string[];

  createdAt: Date;
  expiredAt: Date | null;
  validAt: Date | null;
  invalidAt: Date | null;
}

/** Whether a fact holds at moment `at` in world time. */
export function isValidAt(fact: Fact, at: Date): boolean {
  if (fact.validAt !== null && at < fact.validAt) return false;
  if (fact.invalidAt !== null && at >= fact.invalidAt) return false;
  return true;
}
