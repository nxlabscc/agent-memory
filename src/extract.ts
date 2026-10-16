/**
 * Extracting facts from the prose of a conversation.
 *
 * This is the only fact producer that needs an LLM. The module does **not**
 * pick a provider or a model, and it does not hold the key: it receives a
 * function that completes a prompt. The caller supplies it, with the tenant's
 * own key (BYOK).
 *
 * That injection is not ceremony: it makes extraction testable without a
 * network, and it keeps the part that can go wrong —parsing what a model
 * returned— apart from the part that costs money.
 *
 * What comes out of here are candidates (`FactDraft`), with entities given by
 * name. Resolving them against the ones that already exist is `dedup.ts`'s job.
 */

import type { FactDraft } from "./drafts";

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/** Completes a prompt and returns the raw text. Injected by the consumer. */
export type CompleteFn = (prompt: string) => Promise<string>;

export interface ExtractionRequest extends PromptOptions {
  turns: ConversationTurn[];
  /** Episode the facts come from. Provenance. */
  episodeId: string;
  /**
   * Time of the turn. It is the `valid_at` of everything extracted: when a
   * fact became true is, by default, when it was said. Deducing a date from
   * the text ("since March") is a different job and a different model.
   */
  now: Date;
}

const INSTRUCTIONS = `You extract durable facts from a conversation, for an assistant's long-term memory.

Return ONLY a JSON array, with no explanation and no markdown. Each element:
{"source": "<subject>", "target": "<object>", "fact": "<one-line statement>", "since": "<YYYY-MM-DD or null>"}

Rules:
- A fact is something that stays true after the conversation ends: preferences, decisions, relationships, stable details about the person or their work.
- Do not extract the back-and-forth of the chat, nor what the assistant did or said, nor questions.
- Do not invent anything that was not said. When in doubt, leave it out.
- "source" and "target" are short entity names (people, projects, tools, places). Not phrases.
- When the entity is the person you are talking to, write exactly "user". Not their name, not "the user", not "I": always the same word, because it is the same person across every conversation.
- "fact" is a complete statement that reads on its own. Write it in the THIRD PERSON, never the first: the fact is read back outside its conversation, and in the first person there is no telling who it is about.
- "since" is when the fact STARTED being true, as YYYY-MM-DD, and only when the person said so — "since March", "last Tuesday", "when I moved in 2019". If they did not say, it is null. Do not guess a date from context.
- If there is nothing worth remembering, return [].`;

/**
 * Which language the facts are written in.
 *
 * It comes in as data, not as something the model works out. Measured against
 * the real API, five runs per variant on an English conversation, back when
 * these instructions were written in Spanish:
 *
 *   asking it to use the conversation's language ............... 0/5
 *   the same, with the instructions in English ................. 1/5
 *   having it declare the language and then write in it ........ 2/5
 *   NAMING the language ........................................ 5/5
 *
 * The language of the instructions pulls the output, and a rule asking for
 * something else does not make up for it. With these instructions in English,
 * the facts come out in English whatever the conversation was in — measured on
 * English, Spanish and Portuguese. That is a consistent store, which is what
 * text retrieval needs, but it is not the person's language.
 *
 * Set this to override it. Where the value comes from — the conversation or a
 * user preference — is up to the caller.
 */
export interface PromptOptions {
  /** The language's name, as it is given to the model: "English". */
  language?: string;
  /**
   * Today, so the model can resolve "since March" or "on Tuesday". Without it
   * there is no way to turn a relative date into an absolute one, and relative
   * dates are almost all the ones a person says.
   */
  today?: Date;
}

/** The exact prompt sent to the model. Kept separate so it can be tested. */
export function extractionPrompt(
  turns: ConversationTurn[],
  options: PromptOptions = {},
): string {
  const transcript = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n");
  const today = options.today
    ? `\n\nToday is ${options.today.toISOString().slice(0, 10)}.`
    : "";
  const language = options.language
    ? `\n\nThe conversation is in ${options.language}. Write "fact" and the entity names in ${options.language}, not in the language of these instructions. The only exception is the word "user", which is a key and stays the same in every language.`
    : "";
  return `${INSTRUCTIONS}${today}${language}\n\nConversation:\n${transcript}`;
}

/**
 * Strips the code fence if the model added one anyway. Asking for "no
 * markdown" guarantees nothing, and losing a whole extraction to three
 * backticks would be silly.
 */
function stripCodeFence(raw: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  return match ? (match[1] ?? "") : raw;
}

/**
 * The date the person said, if they said one.
 *
 * An unreadable date counts the same as no date at all: it falls back to the
 * time of the turn. Inventing a `valid_at` out of garbage would be worse than
 * not having one.
 */
function parseSince(value: unknown): Date | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function usableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Result of reading the model's answer.
 *
 * Having no facts and having an unreadable answer are **not** the same thing,
 * and mixing them up is expensive: the caller keeps a mark of how far it has
 * processed, and if an answer cut off halfway is reported as "there was
 * nothing", the mark moves forward and that stretch of conversation is lost
 * for good.
 *
 * It takes no exotic case to get here: it is enough for the model to answer in
 * prose ("I found nothing relevant") instead of JSON.
 */
export type ExtractionOutcome =
  | { ok: true; drafts: FactDraft[] }
  | { ok: false; reason: "not-json" | "not-a-list"; raw: string };

/**
 * Turns the raw answer into candidates.
 *
 * A malformed element inside a well-formed list is dropped silently: the rest
 * of the list is usable and the model already said what it had to say. What
 * is never dropped silently is the answer as a whole.
 */
export function parseExtraction(
  raw: string,
  request: Pick<ExtractionRequest, "episodeId" | "now">,
): ExtractionOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { ok: false, reason: "not-json", raw };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "not-a-list", raw };

  const drafts: FactDraft[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const sourceName = usableText(row.source);
    const targetName = usableText(row.target);
    const fact = usableText(row.fact);
    if (sourceName === null || targetName === null || fact === null) continue;
    drafts.push({
      sourceName,
      targetName,
      fact,
      validAt: parseSince(row.since) ?? request.now,
      episodeId: request.episodeId,
    });
  }
  return { ok: true, drafts };
}

/** Extracts the facts from a stretch of conversation. */
export async function extractFacts(
  complete: CompleteFn,
  request: ExtractionRequest,
): Promise<ExtractionOutcome> {
  if (request.turns.length === 0) return { ok: true, drafts: [] };
  const raw = await complete(
    extractionPrompt(request.turns, { ...request, today: request.today ?? request.now }),
  );
  return parseExtraction(raw, request);
}
