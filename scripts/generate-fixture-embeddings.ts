/**
 * Computes the corpus embeddings for real and writes them to disk.
 *
 * Run by hand and rarely: once, and afterwards only if the corpus changes. The
 * result is committed, so neither the tests nor CI call any API.
 *
 *   GEMINI_API_KEY=... bun scripts/generate-fixture-embeddings.ts
 *
 * `gemini-embedding-2` returns ONE aggregated vector if it is sent several
 * texts together, so they go one at a time. That is about two dozen calls.
 */

import { corpusTexts } from "../test/fixtures/corpus";
import { EMBEDDING_DIMENSIONS } from "../src/embedding";

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("GEMINI_API_KEY is missing.");
  process.exit(2);
}

const MODEL = process.env.EMBEDDING_MODEL ?? "gemini-embedding-2";
const OUTPUT = new URL("../test/fixtures/embeddings.json", import.meta.url);

async function embed(text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": KEY! },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      }),
    },
  );
  const json = (await res.json()) as { embedding?: { values?: number[] } };
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const values = json.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error(`response without an embedding: ${JSON.stringify(json).slice(0, 300)}`);
  }
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`${values.length} dimensions, ${EMBEDDING_DIMENSIONS} were requested`);
  }
  return values;
}

const texts = corpusTexts();
const table: Record<string, number[]> = {};

for (const [i, text] of texts.entries()) {
  // Four decimals: any extra precision only bloats the diff and changes no
  // similarity ordering.
  table[text] = (await embed(text)).map((x) => Number(x.toFixed(4)));
  console.log(`${i + 1}/${texts.length}  ${text.slice(0, 60)}`);
}

await Bun.write(
  OUTPUT,
  `${JSON.stringify({ model: MODEL, dimensions: EMBEDDING_DIMENSIONS, vectors: table }, null, 0)}\n`,
);
console.log(`\n${texts.length} texts → ${OUTPUT.pathname}`);
