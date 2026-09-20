#!/usr/bin/env node
/**
 * Runs the full classification pipeline (regex → BGE-small embeddings → thresholds) against
 * tests/data/titles.json and reports accuracy metrics plus model load time, inference latency
 * and memory usage. Everything runs locally with the model files bundled in ./models.
 *
 * Usage: node scripts/benchmark.mjs [--relevant 0.6] [--questionable 0.45] [--no-regex] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNodeModel } from '../tests/helpers/nodeModel.mjs';
import { ModelManager } from '../src/model/modelManager.js';
import { EmbeddingClassifier } from '../src/classifier/embeddingClassifier.js';
import { RegexClassifier } from '../src/classifier/regexClassifier.js';
import { ClassifierPipeline, makeResult } from '../src/classifier/classifier.js';
import { generateAnchors } from '../src/classifier/anchors.js';
import { DEFAULT_SETTINGS } from '../src/storage/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const settings = {
  ...DEFAULT_SETTINGS,
  relevantThreshold: Number(args.relevant ?? DEFAULT_SETTINGS.relevantThreshold),
  questionableThreshold: Number(args.questionable ?? DEFAULT_SETTINGS.questionableThreshold),
};

const dataset = JSON.parse(fs.readFileSync(path.join(root, 'tests/data/titles.json'), 'utf8'));

const memBefore = process.memoryUsage();
const loadStart = performance.now();
const model = await loadNodeModel();
const loadMs = performance.now() - loadStart;
const memAfterLoad = process.memoryUsage();

const manager = new ModelManager({ loader: async () => model, cacheSize: 5000 });
const embeddingClassifier = new EmbeddingClassifier({ embed: (t) => manager.embed(t), isAvailable: () => true });
const classifiers = args['no-regex'] ? [embeddingClassifier] : [new RegexClassifier(), embeddingClassifier];
const pipeline = new ClassifierPipeline(classifiers, { fallback: () => makeResult('unknown', 'fallback', '') });

// Warm-up (first inference includes WASM/JIT warm-up).
await manager.embed('warm up');

const latencies = [];
const results = [];
for (const row of dataset) {
  const anchors = generateAnchors(row.goal);
  const ctx = { url: 'https://example.com/', domain: 'example.com', title: row.title, text: row.title, goal: row.goal, settings, rules: { allow: [], block: [] }, anchors };
  const t0 = performance.now();
  const result = await pipeline.classify(ctx);
  const ms = performance.now() - t0;
  latencies.push(ms);
  results.push({ ...row, predicted: result.classification, score: result.score, source: result.source, ms });
}
const memAfterRun = process.memoryUsage();

// Raw single-title inference latency (uncached, model warm).
const rawLatencies = [];
for (const row of dataset.slice(0, 40)) {
  const t0 = performance.now();
  await model.embed(row.title + ' ' + Math.random()); // defeat cache
  rawLatencies.push(performance.now() - t0);
}

// ---- Metrics ---------------------------------------------------------------------------------
const labels = ['relevant', 'questionable', 'irrelevant'];
const expectedOf = (r) => (r.expected === 'ambiguous' ? 'questionable' : r.expected);
const confusion = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
for (const r of results) confusion[expectedOf(r)][r.predicted in confusion[expectedOf(r)] ? r.predicted : 'questionable']++;

const threeWayAccuracy = results.filter((r) => r.predicted === expectedOf(r)).length / results.length;

// Binary view (the decision users feel): "blocked" = predicted irrelevant. Positive class = irrelevant.
const clear = results.filter((r) => r.expected !== 'ambiguous');
let tp = 0, fp = 0, tn = 0, fn = 0;
for (const r of clear) {
  const actualBlock = r.expected === 'irrelevant';
  const predBlock = r.predicted === 'irrelevant';
  if (actualBlock && predBlock) tp++;
  else if (!actualBlock && predBlock) fp++;
  else if (!actualBlock && !predBlock) tn++;
  else fn++;
}
const precision = tp / Math.max(1, tp + fp);
const recall = tp / Math.max(1, tp + fn);
const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
const fpr = fp / Math.max(1, fp + tn);
const fnr = fn / Math.max(1, fn + tp);
const binaryAccuracy = (tp + tn) / Math.max(1, clear.length);

// "Relevant vs not relevant" view, positive class = relevant.
let rtp = 0, rfp = 0, rtn = 0, rfn = 0;
for (const r of clear) {
  const a = r.expected === 'relevant';
  const p = r.predicted === 'relevant';
  if (a && p) rtp++; else if (!a && p) rfp++; else if (!a && !p) rtn++; else rfn++;
}
const ambiguousAsQuestionable = results.filter((r) => r.expected === 'ambiguous' && r.predicted === 'questionable').length;
const ambiguousBlocked = results.filter((r) => r.expected === 'ambiguous' && r.predicted === 'irrelevant').length;
const ambiguousTotal = results.filter((r) => r.expected === 'ambiguous').length;

const mb = (b) => Math.round(b / 1048576);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return { mean: avg(arr), p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};
const report = {
  model: 'bge-small-en-v1.5 (int8 ONNX, Transformers.js 2.17.2, WASM single thread)',
  thresholds: { relevant: settings.relevantThreshold, questionable: settings.questionableThreshold },
  regexLayer: !args['no-regex'],
  dataset: { size: dataset.length, relevant: dataset.filter((r) => r.expected === 'relevant').length, irrelevant: dataset.filter((r) => r.expected === 'irrelevant').length, ambiguous: ambiguousTotal },
  threeWay: { accuracy: threeWayAccuracy, confusion },
  blockDecision: { accuracy: binaryAccuracy, precision, recall, f1, falsePositiveRate: fpr, falseNegativeRate: fnr, tp, fp, tn, fn, note: 'positive class = irrelevant (would be blocked); ambiguous rows excluded' },
  relevantDecision: { precision: rtp / Math.max(1, rtp + rfp), recall: rtp / Math.max(1, rtp + rfn), tp: rtp, fp: rfp, tn: rtn, fn: rfn },
  ambiguous: { total: ambiguousTotal, predictedQuestionable: ambiguousAsQuestionable, predictedIrrelevant: ambiguousBlocked },
  performance: {
    modelLoadMs: Math.round(loadMs),
    pipelineLatencyMs: stats(latencies),
    rawInferenceLatencyMs: stats(rawLatencies),
    rssBeforeMB: mb(memBefore.rss),
    rssAfterLoadMB: mb(memAfterLoad.rss),
    rssAfterRunMB: mb(memAfterRun.rss),
    modelMemoryDeltaMB: mb(memAfterLoad.rss - memBefore.rss),
    heapUsedMB: mb(memAfterRun.heapUsed),
  },
  bySource: countBy(results, (r) => r.source),
  mistakes: results.filter((r) => r.predicted !== expectedOf(r)).map((r) => ({ goal: r.goalKey, title: r.title, expected: r.expected, predicted: r.predicted, score: r.score, source: r.source })),
};

console.log(`\nGoalGuard benchmark — ${report.model}`);
console.log(`Thresholds: relevant ≥ ${settings.relevantThreshold}, questionable ≥ ${settings.questionableThreshold}  (regex layer ${report.regexLayer ? 'on' : 'off'})`);
console.log(`Dataset: ${dataset.length} titles (${report.dataset.relevant} relevant / ${report.dataset.irrelevant} irrelevant / ${ambiguousTotal} ambiguous)\n`);
console.log(`Three-way accuracy:          ${pct(threeWayAccuracy)}`);
console.log('Confusion (rows = expected, cols = predicted):');
console.log('                 relevant  questionable  irrelevant');
for (const a of labels) console.log(`  ${a.padEnd(14)} ${String(confusion[a].relevant).padStart(8)}  ${String(confusion[a].questionable).padStart(12)}  ${String(confusion[a].irrelevant).padStart(10)}`);
console.log(`\nBlock decision (irrelevant = positive, ambiguous excluded):`);
console.log(`  accuracy ${pct(binaryAccuracy)}  precision ${pct(precision)}  recall ${pct(recall)}  F1 ${pct(f1)}`);
console.log(`  false-positive rate ${pct(fpr)} (relevant pages wrongly blocked)  false-negative rate ${pct(fnr)} (irrelevant pages let through)`);
console.log(`Relevant decision: precision ${pct(report.relevantDecision.precision)}  recall ${pct(report.relevantDecision.recall)}`);
console.log(`Ambiguous titles: ${ambiguousAsQuestionable}/${ambiguousTotal} → questionable, ${ambiguousBlocked}/${ambiguousTotal} → irrelevant`);
console.log(`\nDecided by: ${Object.entries(report.bySource).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`\nPerformance:`);
console.log(`  model load          ${Math.round(loadMs)} ms`);
console.log(`  raw inference       mean ${report.performance.rawInferenceLatencyMs.mean.toFixed(1)} ms, p50 ${report.performance.rawInferenceLatencyMs.p50.toFixed(1)} ms, p95 ${report.performance.rawInferenceLatencyMs.p95.toFixed(1)} ms`);
console.log(`  pipeline per title  mean ${report.performance.pipelineLatencyMs.mean.toFixed(1)} ms (includes anchor embedding on first use per goal)`);
console.log(`  RSS before/after    ${mb(memBefore.rss)} MB → ${mb(memAfterLoad.rss)} MB after load → ${mb(memAfterRun.rss)} MB after run (Δ model ≈ ${report.performance.modelMemoryDeltaMB} MB)`);
if (report.mistakes.length) {
  console.log(`\nMisclassified (${report.mistakes.length}):`);
  for (const m of report.mistakes) console.log(`  [${m.goal}] "${m.title}" expected ${m.expected}, got ${m.predicted} (score ${m.score ?? '-'}, ${m.source})`);
}
if (args.json) {
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${args.json}`);
}

function avg(a) { return a.reduce((s, x) => s + x, 0) / Math.max(1, a.length); }
function countBy(list, fn) { const out = {}; for (const x of list) { const k = fn(x); out[k] = (out[k] ?? 0) + 1; } return out; }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
