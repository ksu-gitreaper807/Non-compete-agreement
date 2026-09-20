#!/usr/bin/env node
/**
 * Layer ablation benchmark: runs the real DecisionPipeline over tests/data/titles.json in four
 * configurations and reports whether search and the local LLM actually improve classification.
 *
 *   BGE only · BGE + search · BGE + LLM · BGE + search + LLM
 *
 * Search is served offline from tests/data/search-fixtures.json (deterministic, no network).
 * The LLM defaults to a *mock* that reasons only over the supplied context — it stands in for
 * "a model that follows the prompt" so the pipeline logic can be measured without weights. Pass
 * `--llm ollama` / `--llm llamacpp` (with a local server running) to measure a real model.
 *
 * Usage: node scripts/benchmark-layers.mjs [--llm mock|ollama|llamacpp] [--endpoint URL] [--model NAME]
 *        [--search-mode uncertain|ambiguous] [--json out.json] [--subset ambiguous]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNodeModel } from '../tests/helpers/nodeModel.mjs';
import { ModelManager } from '../src/model/modelManager.js';
import { EmbeddingClassifier } from '../src/classifier/embeddingClassifier.js';
import { RegexClassifier } from '../src/classifier/regexClassifier.js';
import { generateAnchors } from '../src/classifier/anchors.js';
import { DEFAULT_SETTINGS } from '../src/storage/schema.js';
import { DecisionPipeline } from '../src/intelligence/decisionPipeline.js';
import { SearchManager } from '../src/search/searchManager.js';
import { MockSearchProvider } from '../src/search/searchProvider.js';
import { RateLimiter } from '../src/search/rateLimiter.js';
import { LlmManager } from '../src/llm/llmManager.js';
import { LlmClassifier } from '../src/llm/llmClassifier.js';
import { OllamaAdapter, LlamaCppAdapter } from '../src/llm/localLLM.js';
import { PersistentCache } from '../src/storage/cacheStore.js';
import { informativeWords } from '../src/search/queryBuilder.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const dataset = JSON.parse(fs.readFileSync(path.join(root, 'tests/data/titles.json'), 'utf8')).filter((r) => (args.subset === 'ambiguous' ? r.ambiguousTitle : true));
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tests/data/search-fixtures.json'), 'utf8'));

const model = await loadNodeModel();
await model.embed('warm up');

const configs = [
  { name: 'BGE only', llmEnabled: false, searchEnabled: false },
  { name: 'BGE + search', llmEnabled: false, searchEnabled: true },
  { name: 'BGE + LLM', llmEnabled: true, searchEnabled: false },
  { name: 'BGE + search + LLM', llmEnabled: true, searchEnabled: true },
];

const report = { llm: args.llm ?? 'mock', searchMode: args['search-mode'] ?? 'uncertain', dataset: { size: dataset.length }, configs: [] };
for (const cfg of configs) {
  const out = await runConfig(cfg);
  report.configs.push(out);
}
printReport(report);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));

// -------------------------------------------------------------------------------------------------

async function runConfig(cfg) {
  // Fresh embedding cache per configuration so latencies are comparable (model stays loaded).
  const manager = new ModelManager({ loader: async () => model });
  const embed = (t) => manager.embed(t);
  const provider = new MockSearchProvider({ fixtures });
  const search = new SearchManager({ provider, cache: new PersistentCache('retrieval', { persist: false }), rateLimiter: new RateLimiter({ minIntervalMs: 0, maxPerMinute: 1e9, maxPerSession: 1e9 }), embed });
  const llmManager = cfg.llmEnabled ? new LlmManager({ loader: async () => createLlm(), timeoutMs: 120000, idleUnloadMs: 0 }) : null;
  const llm = llmManager ? new LlmClassifier({ llm: llmManager, cache: new PersistentCache('llm', { persist: false }) }) : null;
  const pipeline = new DecisionPipeline({
    regex: new RegexClassifier(),
    embedding: new EmbeddingClassifier({ embed, isAvailable: () => true }),
    search,
    llm,
  });
  // "BGE + search" without an LLM has no consumer for the context, so the search stage is
  // forced on to measure its cost, and its evidence is reported but cannot change verdicts.
  const settings = { ...DEFAULT_SETTINGS, llmEnabled: cfg.llmEnabled || cfg.searchEnabled, searchEnabled: cfg.searchEnabled, searchMode: report.searchMode };
  const searchOnly = cfg.searchEnabled && !cfg.llmEnabled;
  if (searchOnly) pipeline.llm = { name: 'llm', classify: async () => null }; // context fetched, nobody judges

  const rows = [];
  const latencies = [];
  for (const row of dataset) {
    const anchors = generateAnchors(row.goal);
    const domain = row.domain ?? 'example.com';
    const ctx = { url: `https://${domain}/`, domain, title: row.title, text: row.title, goal: row.goal, settings, rules: { allow: [], block: [] }, anchors };
    const t0 = performance.now();
    const r = await pipeline.classify(ctx);
    const ms = performance.now() - t0;
    latencies.push(ms);
    rows.push({ ...row, predicted: r.classification, source: r.source, sourceKind: r.sourceKind, evidenceQuality: r.evidenceQuality, confidence: r.confidence, ms });
  }
  const tel = pipeline.getTelemetry();
  return { name: cfg.name, ...metrics(rows), latency: stats(latencies), searchRequests: provider.calls.length, searchCacheHits: tel.counters.searchCacheHits, llmInvocations: llmManager?.stats.completions ?? 0, llmCacheHits: tel.counters.llmCacheHits, downgraded: tel.counters.downgraded, mistakes: rows.filter((r) => r.predicted !== expectedOf(r)).map((r) => ({ title: r.title, domain: r.domain, expected: expectedOf(r), predicted: r.predicted, source: r.source, evidence: r.evidenceQuality })) };
}

function expectedOf(r) {
  return r.expected === 'ambiguous' ? 'questionable' : r.expected;
}

function metrics(rows) {
  const labels = ['relevant', 'questionable', 'irrelevant'];
  const confusion = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
  for (const r of rows) confusion[expectedOf(r)][labels.includes(r.predicted) ? r.predicted : 'questionable']++;
  const accuracy = rows.filter((r) => r.predicted === expectedOf(r)).length / rows.length;
  const clear = rows.filter((r) => expectedOf(r) !== 'questionable');
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of clear) {
    const a = expectedOf(r) === 'irrelevant';
    const p = r.predicted === 'irrelevant';
    if (a && p) tp++; else if (!a && p) fp++; else if (!a && !p) tn++; else fn++;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const amb = rows.filter((r) => r.ambiguousTitle);
  return {
    n: rows.length,
    threeWayAccuracy: accuracy,
    confusion,
    block: { precision, recall, f1: (2 * precision * recall) / Math.max(1e-9, precision + recall), falsePositiveRate: fp / Math.max(1, fp + tn), falseNegativeRate: fn / Math.max(1, fn + tp) },
    ambiguousTitles: { n: amb.length, accuracy: amb.length ? amb.filter((r) => r.predicted === expectedOf(r)).length / amb.length : null },
    bySource: countBy(rows, (r) => r.source),
  };
}

/**
 * Mock LLM: follows the system prompt literally. Relevant if the web context (or, failing that,
 * the title) shares informative words with the goal; irrelevant if it matches distraction terms;
 * questionable when the context says nothing. Confidence scales with how much context existed.
 */
function createLlm() {
  if (args.llm === 'ollama') return new OllamaAdapter({ endpoint: args.endpoint, model: args.model });
  if (args.llm === 'llamacpp') return new LlamaCppAdapter({ endpoint: args.endpoint, model: args.model });
  const DISTRACTION = ['game', 'games', 'gaming', 'celebrity', 'gossip', 'viral', 'entertainment', 'sales', 'business', 'management', 'forbes', 'buzzfeed', 'reddit', 'patch', 'hobbies', 'quizzes', 'design inspiration', 'consulting'];
  return {
    modelVersion: 'mock-llm',
    async complete(messages) {
      const payload = JSON.parse(messages[1].content);
      const goalWords = new Set(informativeWords(payload.goal).concat(['kernel', 'linux', 'scheduling', 'process', 'processes', 'memory', 'systems', 'concurrency', 'compiler']));
      const ctx = (payload.webContext ?? []).map((r) => `${r.title} ${r.snippet ?? ''}`).join(' ').toLowerCase();
      const hasContext = ctx.trim().length > 0;
      const text = hasContext ? ctx : '';
      const words = informativeWords(text);
      const hits = words.filter((w) => goalWords.has(w));
      const bad = DISTRACTION.filter((w) => text.includes(w));
      let classification = 'questionable';
      let confidence = 0.4;
      if (hasContext && hits.length >= 2 && bad.length === 0) { classification = 'relevant'; confidence = Math.min(0.95, 0.6 + hits.length * 0.1); }
      else if (hasContext && bad.length >= 1 && hits.length === 0) { classification = 'irrelevant'; confidence = Math.min(0.9, 0.6 + bad.length * 0.1); }
      const evidence = [...new Set([...hits, ...bad])].slice(0, 3);
      return JSON.stringify({ classification, confidence, reason: hasContext ? `Context mentions ${evidence.join(', ') || 'nothing decisive'}.` : 'No context establishes what the page is about.', evidence });
    },
  };
}

function printReport(rep) {
  const pct = (x) => (x == null ? '   -  ' : `${(x * 100).toFixed(1)}%`.padStart(6));
  console.log(`\nGoalGuard layer ablation — ${rep.dataset.size} titles, LLM=${rep.llm}, searchMode=${rep.searchMode}\n`);
  console.log('config               3-way   ambig   blockP  blockR  FPR     FNR     p50ms   p95ms   searches  llm  downgr');
  for (const c of rep.configs) {
    console.log(`${c.name.padEnd(20)} ${pct(c.threeWayAccuracy)} ${pct(c.ambiguousTitles.accuracy)} ${pct(c.block.precision)} ${pct(c.block.recall)} ${pct(c.block.falsePositiveRate)} ${pct(c.block.falseNegativeRate)} ${String(c.latency.p50.toFixed(1)).padStart(7)} ${String(c.latency.p95.toFixed(1)).padStart(7)} ${String(c.searchRequests).padStart(9)} ${String(c.llmInvocations).padStart(4)} ${String(c.downgraded).padStart(6)}`);
  }
  for (const c of rep.configs) {
    console.log(`\n${c.name}: decided by ${Object.entries(c.bySource).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (c.mistakes.length && args.verbose) for (const m of c.mistakes) console.log(`  "${m.title}"${m.domain ? ` @${m.domain}` : ''} expected ${m.expected}, got ${m.predicted} (${m.source}, evidence ${m.evidence})`);
    else console.log(`  ${c.mistakes.length} mistakes (run with --verbose to list)`);
  }
  if (rep.llm === 'mock') console.log('\nNOTE: LLM=mock follows the prompt rules deterministically; it measures the pipeline, not a real model. Use --llm ollama --model qwen3:0.6b for real numbers.');
}

function stats(arr) { const s = [...arr].sort((a, b) => a - b); return { mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p50: s[Math.floor(s.length * 0.5)] ?? 0, p95: s[Math.floor(s.length * 0.95)] ?? 0 }; }
function countBy(list, fn) { const out = {}; for (const x of list) { const k = fn(x); out[k] = (out[k] ?? 0) + 1; } return out; }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}
