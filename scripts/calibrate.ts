/**
 * Calibrates the similarity thresholds against human judgment.
 *
 * It runs on the fixture, with no network. The STS Benchmark pairs carry a
 * similarity annotated by people from 0 to 5; this measures which cosine
 * corresponds to them and at what cutoff our decisions agree with theirs.
 */
import { STS_PAIRS } from "../test/fixtures/corpus";
import fixture from "../test/fixtures/embeddings.json" with { type: "json" };
import { cosineSimilarity } from "../src/rerank";
import { sameFactText } from "../src/dedup";

const vectors = (fixture as { vectors: Record<string, number[]> }).vectors;
const cos = (a: string, b: string) => cosineSimilarity(vectors[a]!, vectors[b]!);

const measured = STS_PAIRS.map((p) => ({ ...p, cos: cos(p.a, p.b) }));

function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      const mid = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[order[k]![1]] = mid;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

console.log(`Spearman cosine vs human judgment: ${spearman(measured.map((m) => m.cos), measured.map((m) => m.score)).toFixed(3)}  (n=${measured.length})`);

console.log("\ncosine per human score band");
for (const band of [0, 1, 2, 3, 4]) {
  const inBand = measured.filter((m) => Math.min(Math.floor(m.score), 4) === band);
  const cs = inBand.map((m) => m.cos).sort((a, b) => a - b);
  const mean = cs.reduce((a, b) => a + b, 0) / cs.length;
  console.log(`  ${band}-${band + 1}  n=${String(cs.length).padStart(2)}  min=${cs[0]!.toFixed(3)}  mean=${mean.toFixed(3)}  max=${cs[cs.length - 1]!.toFixed(3)}`);
}

// "The same fact" is equivalence, not resemblance. On the STS scale that is 4
// and up: 4 is "mostly equivalent", 5 is "completely equivalent".
const SAME = 4.0;
console.log(`\ncutoff for 'is the same fact' (human >= ${SAME})`);
console.log("  threshold  precision  recall  F1   false positives");
for (let t = 0.70; t <= 0.96; t += 0.02) {
  const tp = measured.filter((m) => m.cos >= t && m.score >= SAME).length;
  const fp = measured.filter((m) => m.cos >= t && m.score < SAME).length;
  const fn = measured.filter((m) => m.cos < t && m.score >= SAME).length;
  const p = tp + fp === 0 ? 1 : tp / (tp + fp);
  const r = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  console.log(`   ${t.toFixed(2)}       ${p.toFixed(2)}      ${r.toFixed(2)}   ${f1.toFixed(2)}   ${fp}`);
}

// What decides today, without embeddings.
const jac = measured.map((m) => ({ ...m, same: sameFactText(m.a, m.b) }));
const jacTp = jac.filter((m) => m.same && m.score >= SAME).length;
const jacFp = jac.filter((m) => m.same && m.score < SAME).length;
const jacFn = jac.filter((m) => !m.same && m.score >= SAME).length;
console.log(`\ntoday's deterministic dedup: ${jacTp} hits, ${jacFp} false positives, ${jacFn} missed (out of ${measured.filter((m) => m.score >= SAME).length} equivalent)`);

console.log("\nthe pairs that decide the cutoff");
for (const m of [...measured].sort((a, b) => b.cos - a.cos)) {
  if (m.cos >= 0.86 && m.cos <= 0.96) {
    const eq = m.score >= SAME ? "equivalent    " : "NOT equivalent";
    console.log(`  cos=${m.cos.toFixed(3)} human=${m.score.toFixed(1)} ${eq} | ${m.a.slice(0, 44)} || ${m.b.slice(0, 44)}`);
  }
}
