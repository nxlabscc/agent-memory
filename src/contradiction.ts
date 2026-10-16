/**
 * Judging whether a new statement contradicts what is already known.
 *
 * `invalidation.ts` already decides which interval closes which — that part is
 * date arithmetic and needs no model. What it cannot decide is whether two
 * statements about the same pair of entities are in conflict at all: "works at
 * Acme" and "founded Acme" share every entity and contradict nothing, while
 * "uses Neovim" and "uses VSCode" share the same shape and cannot both hold.
 *
 * That judgement is the residue the deterministic pass leaves behind, and it
 * is the only part of invalidation that needs an LLM. As with the extractor,
 * the model is injected: this module neither chooses it nor holds a key.
 *
 * The default is to leave facts alone. An unreadable answer means no
 * contradiction, because closing a fact by mistake destroys knowledge while
 * keeping a stale one merely clutters.
 */

const INSTRUCTIONS = `You decide whether a new statement makes older statements no longer true.

You get one NEW statement and a numbered list of OLD statements that are currently held to be true about the same pair of entities.

Return ONLY a JSON array of the numbers of the OLD statements that the NEW one makes no longer true. No explanation, no markdown.

Rules:
- Include a number only if both cannot be true at the same time. A change of state, a replacement, a correction.
- Do NOT include statements that simply say something different about the same things. Two facts can both be true.
- Do NOT include statements that repeat the new one. Repetition is not contradiction.
- When in doubt, leave it out: a wrong answer here erases something the person told us.
- If nothing is contradicted, return [].`;

export function contradictionPrompt(
  incoming: string,
  existing: string[],
): string {
  const numbered = existing.map((text, i) => `${i + 1}. ${text}`).join("\n");
  return `${INSTRUCTIONS}\n\nNEW statement:\n${incoming}\n\nOLD statements:\n${numbered}`;
}

/**
 * The indices (0-based) of the statements the model marked as contradicted.
 *
 * Anything out of range, repeated, or not a number is dropped: the model is
 * answering about a list it was shown, and a number that is not in that list
 * refers to nothing.
 */
export function parseContradiction(raw: string, count: number): number[] {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? (fenced[1] ?? "") : raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out = new Set<number>();
  for (const item of parsed) {
    if (typeof item !== "number" || !Number.isInteger(item)) continue;
    const index = item - 1;
    if (index < 0 || index >= count) continue;
    out.add(index);
  }
  return [...out].sort((a, b) => a - b);
}

/** Which of `existing` the incoming statement contradicts. */
export async function judgeContradictions(
  complete: (prompt: string) => Promise<string>,
  incoming: string,
  existing: string[],
): Promise<number[]> {
  if (existing.length === 0) return [];
  const raw = await complete(contradictionPrompt(incoming, existing));
  return parseContradiction(raw, existing.length);
}
