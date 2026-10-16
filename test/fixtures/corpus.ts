/**
 * The texts whose real embeddings live in `embeddings.json`.
 *
 * These are not examples: each group exists to make one property of retrieval
 * observable. A test can only assert an ordering if the geometry underneath is
 * real, so the vectors are computed once with the real model and committed —
 * the tests never call an API, and they never depend on an invented distance.
 *
 * Adding a text here without regenerating the file leaves it without a vector.
 * There is a test for that.
 */

export interface FixtureGroup {
  /** Which property of retrieval this group makes observable. */
  purpose: string;
  texts: string[];
}

export const CORPUS: FixtureGroup[] = [
  {
    // They share the subject and almost no words. It is the case full-text
    // cannot handle: searching "editor" does not find "Neovim" by text, but it
    // does by vector.
    purpose: "same subject said with different words",
    texts: [
      "the user edits everything in Neovim",
      "the user prefers terminal editors over graphical ones",
      "the user has a heavily customized vim configuration",
    ],
  },
  {
    // Almost the same thing said two ways. The deterministic dedup does NOT
    // merge them —the trigram threshold is not reached— so this measures how far
    // apart they really are, and that decides whether a similarity threshold
    // brings them together.
    purpose: "paraphrases the deterministic dedup cannot merge",
    texts: [
      "the user likes Taylor Swift",
      "the user enjoys listening to Taylor Swift's music",
      "Taylor Swift is one of the user's favorite artists",
    ],
  },
  {
    // Close and different. The running application that serves requests is not
    // the set of activities that build it. A threshold that merges them is
    // miscalibrated, and this group is the one that catches it.
    purpose: "related but not the same thing",
    texts: [
      "Atlas runs on Bun and serves the chat over HTTP",
      "the Atlas project started in 2026 and is still in phase one",
      "the user works on the Atlas project every day",
    ],
  },
  {
    // They exclude each other. Useful for the day contradiction detection looks
    // at similarity besides the entity pair: two incompatible facts are VERY
    // close in the space, which is exactly what makes them dangerous.
    purpose: "mutually exclusive statements about the same thing",
    texts: [
      "the user's main editor is Neovim",
      "the user switched from Neovim to VSCode",
      "the user no longer uses Neovim",
    ],
  },
  {
    // With no competition a query hits by elimination. These are the ones that
    // have to rank low.
    purpose: "unrelated distractors",
    texts: [
      "the user has a cat named Mochi",
      "the user goes bird watching on Sundays",
      "the user wrestles for a living",
      "the user has lived in Rosario since March 2026",
      "the user volunteers at a homeless shelter",
      "the user drinks mate every morning",
    ],
  },
  {
    // What retrieval embeds on the other side. They live here because a query
    // looks like a fact neither in shape nor in length, and testing with a
    // fact's text as the query would measure something easier than the real
    // thing.
    purpose: "queries, the other side of retrieval",
    texts: [
      "what editor does the user use?",
      "what music does the user listen to?",
      "what pets does the user have?",
      "where does the user live?",
      "what is Atlas?",
      "tell me about the user's weekend habits",
    ],
  },
];

/**
 * STS Benchmark pairs with their human-annotated similarity, from 0 to 5.
 *
 * Sixty pairs, twelve per score band, taken in dataset order so the sample is
 * the same every time it is looked at.
 *
 * It is the calibration instrument: it says how similar two sentences are
 * according to people, not according to us. A threshold picked by eye is an
 * opinion; one that reproduces these scores is a measurement.
 */
import sample from "./sts-sample.json" with { type: "json" };

export interface StsPair {
  /** Annotated similarity, 0 to 5. */
  score: number;
  a: string;
  b: string;
}

export const STS_PAIRS: StsPair[] = sample as StsPair[];

/** The corpus queries, which are the other side of retrieval. */
export function corpusQueries(): string[] {
  return CORPUS.find((g) => g.purpose.startsWith("queries"))?.texts ?? [];
}

/** Every text that needs a vector, in a stable order. */
export function corpusTexts(): string[] {
  const own = CORPUS.flatMap((group) => group.texts);
  const sts = STS_PAIRS.flatMap((pair) => [pair.a, pair.b]);
  return [...new Set([...own, ...sts])];
}
