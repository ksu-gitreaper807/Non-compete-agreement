/**
 * LocalLLM runtime abstraction. The classifier depends on this interface only; concrete
 * adapters wrap a specific local runtime. No adapter ever calls a cloud API.
 *
 *   LocalLLM
 *     ├── NliJudgeAdapter         DEFAULT: tiny NLI cross-encoder (nli-deberta-v3-xsmall, int8 ≈70 MB)
 *     │                           answers "is this page about the goal?" directly — no free text
 *     ├── TransformersJsAdapter   in-extension generative model (Qwen2.5-0.5B, ≈400 MB) — optional
 *     ├── OllamaAdapter           http://localhost:11434 (user-run local server)
 *     └── LlamaCppAdapter         llama.cpp `llama-server` OpenAI-compatible endpoint on localhost
 *
 * Every adapter returns the same strict JSON verdict string, so responseParser and the
 * evidence policy do not care which one produced it.
 */

import { parsePayload } from './promptBuilder.js';
import { goalTopicPhrase } from './promptContext.js';

export const NLI_MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';
export const NLI_MODEL_VERSION = `${NLI_MODEL_ID}@q8`;
export const LLM_MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
export const LLM_MODEL_VERSION = `${LLM_MODEL_ID}@q4`;
export const DEFAULT_MAX_NEW_TOKENS = 120;

// Entailment probability cut-offs for the NLI judge (heuristic, see docs/CLASSIFICATION.md).
export const NLI_THRESHOLDS = Object.freeze({ relevant: 0.7, irrelevant: 0.3 });

export class LocalLLM {
  /** Identifies the weights; part of the LLM cache key. */
  get modelVersion() {
    return 'unknown';
  }

  /**
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ maxNewTokens?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<string>} raw assistant text (expected to contain JSON)
   */
  // eslint-disable-next-line no-unused-vars
  async complete(messages, options = {}) {
    throw new Error('complete() not implemented');
  }

  async dispose() {}
}

// ---- NLI judge (in-browser, default) -----------------------------------------------------------

/**
 * Treats relevance as textual entailment: premise = what we know about the page, hypothesis =
 * "This page is about <goal>." The model outputs P(entailment) per premise; the adapter maps
 * that to the verdict JSON the pipeline expects. Each web-context row is scored separately so
 * the evidence list contains exactly the rows that supported the verdict.
 *
 * @param {(premise: string, hypothesis: string) => Promise<number>} entail  P(entailment) in [0,1]
 */
export class NliJudgeAdapter extends LocalLLM {
  constructor(entail, { modelVersion = NLI_MODEL_VERSION, thresholds = NLI_THRESHOLDS, dispose = null } = {}) {
    super();
    this.entail = entail;
    this.version = modelVersion;
    this.thresholds = thresholds;
    this.disposeFn = dispose;
  }

  get modelVersion() {
    return this.version;
  }

  async complete(messages) {
    const payload = parsePayload(messages);
    if (!payload?.goal || !payload.page?.title) return JSON.stringify({ classification: 'questionable', confidence: 0, reason: 'No page information supplied.', evidence: [] });

    // Trap 2 of the primer, enforced rather than hoped for: a title that carries no information
    // and no web context cannot support any verdict. Answering questionable here also saves the
    // inference, and the pipeline would downgrade the answer to questionable anyway.
    if (payload.hints?.titleIsGeneric && !payload.hints?.hasWebContext) {
      return JSON.stringify({
        classification: 'questionable',
        confidence: 0,
        reason: 'The page title carries too little information and no web context was available.',
        evidence: [],
        entailment: null,
      });
    }

    // Hypothesis in the model's own register: a declarative statement about a topic, not an
    // imperative goal ("Study OS" → "This page is about operating systems.").
    const hypothesis = `This page is about ${goalTopicPhrase(payload.goal) || payload.goal}.`;

    const scored = [{ text: payload.page.title, premise: titlePremise(payload.page, payload.hints?.pageKind), kind: 'title' }];
    for (const r of payload.webContext ?? []) scored.push({ text: r.title, premise: contextPremise(r), kind: 'context', weight: rowWeight(r) });
    for (const item of scored) item.p = clamp01(await this.entail(item.premise, hypothesis));

    // Web context, when present, describes the page better than a bare title: weight it 2:1.
    // Rows are weighted by how well the search ranked them for *this* page, so a row about a
    // different page with a similar name cannot cancel out the rows that are on target.
    const context = scored.filter((s) => s.kind === 'context');
    const titleP = scored[0].p;
    // Trim the single most contradictory row when there are enough rows to spare. Search
    // routinely returns a *different* page that shares the name ("Antigravity (physics)" for
    // "Google Antigravity"), it ranks well by title similarity, and one such row used to cancel
    // out every on-target row. Trimmed means are the standard defence; the dilution guard below
    // keeps the safe side of it.
    const usable = context.length >= 3 ? dropWeakest(context) : context;
    const contextP = usable.length ? weightedMean(usable) : null;
    const p = contextP === null ? titleP : (2 * contextP + titleP) / 3;
    // Best single row: the strongest evidence that the page *is* about the goal.
    const support = context.length ? Math.max(...context.map((s) => s.p)) : titleP;

    let classification = 'questionable';
    let diluted = false;
    if (p >= this.thresholds.relevant) classification = 'relevant';
    else if (p <= this.thresholds.irrelevant) {
      // Dilution guard: a low average means the context is noisy, not that the page is
      // off-goal. If any supplied row actually supports the goal, do not block the page.
      if (support >= this.thresholds.relevant) {
        classification = 'questionable';
        diluted = true;
      } else {
        classification = 'irrelevant';
      }
    }
    const confidence = confidenceFor(classification, p, this.thresholds);
    const evidence = classification === 'questionable' ? [] : scored.filter((s) => (classification === 'relevant' ? s.p >= this.thresholds.relevant : s.p <= this.thresholds.irrelevant)).map((s) => s.text).slice(0, 3);
    const reason = classification === 'relevant'
      ? `Page context entails the goal (${Math.round(p * 100)}% entailment).`
      : classification === 'irrelevant'
        ? `Page context does not entail the goal (${Math.round(p * 100)}% entailment).`
        : diluted
          ? `Context is mixed: the average is ${Math.round(p * 100)}% but one source reaches ${Math.round(support * 100)}% entailment, so the page is left questionable.`
          : `Entailment is undecided (${Math.round(p * 100)}%).`;
    return JSON.stringify({ classification, confidence, reason, evidence, entailment: round2(p), support: round2(support) });
  }

  async dispose() {
    try {
      await this.disposeFn?.();
    } catch {
      /* ignore */
    }
  }
}

/** Loads the NLI cross-encoder through the bundled Transformers.js (weights cached by the browser). */
export async function loadNliJudge({ transformersUrl, wasmUrl, modelId = NLI_MODEL_ID, onProgress, allowRemote = true }) {
  const { pipeline, env } = await import(transformersUrl);
  configureEnv(env, wasmUrl, allowRemote);
  const classifier = await pipeline('zero-shot-classification', modelId, { quantized: true, progress_callback: onProgress });
  // Direct pair scoring (premise, hypothesis) → softmax over contradiction/entailment/neutral,
  // avoiding the zero-shot template so the hypothesis wording stays under our control.
  const entail = async (premise, hypothesis) => {
    const inputs = classifier.tokenizer(premise, { text_pair: hypothesis, padding: true, truncation: true });
    const { logits } = await classifier.model(inputs);
    const row = Array.from(logits.data);
    const idx = classifier.entailment_id ?? Number(Object.entries(classifier.model.config.label2id ?? {}).find(([k]) => /entail/i.test(k))?.[1] ?? 1);
    return softmax(row)[idx];
  };
  return new NliJudgeAdapter(entail, { modelVersion: `${modelId}@q8`, dispose: () => classifier.dispose?.() });
}

/**
 * Search rows are not equally trustworthy: `relevance` is how well the row matched this page
 * (embedding cosine, or lexical overlap as a fallback). Weight it rather than trusting it
 * absolutely — a good row can still rank poorly, and a bad row can rank well.
 */
function rowWeight(row) {
  const rel = Number(row?.relevance);
  const base = Number.isFinite(rel) ? Math.min(1, Math.max(0, rel)) : 0.5;
  return 0.3 + 0.7 * base;
}

/** Rows except the one with the lowest entailment (ties: the first). */
function dropWeakest(rows) {
  let worst = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].p < rows[worst].p) worst = i;
  return rows.filter((_, i) => i !== worst);
}

function weightedMean(rows) {
  const total = rows.reduce((a, s) => a + s.weight, 0);
  if (total <= 0) return rows.reduce((a, s) => a + s.p, 0) / rows.length;
  return rows.reduce((a, s) => a + s.p * s.weight, 0) / total;
}

/**
 * Confidence in [0,1], expressed against the decision thresholds rather than against the
 * undecided middle: a verdict at exactly its threshold is 0.6 (which is the default
 * `llmMinConfidence`), and it rises to 1 as the entailment moves away from the boundary.
 *
 * The old formula (`|p − 0.5|·2`) reported 0.4 for a page at the "relevant" threshold 0.7,
 * so genuine hits were quietly downgraded to *questionable* by the evidence policy.
 */
export function confidenceFor(classification, p, thresholds = NLI_THRESHOLDS) {
  if (classification === 'relevant') return round2(0.6 + 0.4 * clamp01((p - thresholds.relevant) / Math.max(1e-6, 1 - thresholds.relevant)));
  if (classification === 'irrelevant') return round2(0.6 + 0.4 * clamp01((thresholds.irrelevant - p) / Math.max(1e-6, thresholds.irrelevant)));
  // Questionable: how close the entailment came to a decision (0 in the middle of the band).
  const band = Math.max(1e-6, (thresholds.relevant - thresholds.irrelevant) / 2);
  const distance = Math.min(Math.abs(p - thresholds.relevant), Math.abs(p - thresholds.irrelevant));
  return round2(0.45 * clamp01(1 - distance / band));
}

/**
 * Premise for the page itself. Framed as a description of the page rather than a bare string,
 * because the NLI cross-encoder scores "premise entails hypothesis" — it needs to know that the
 * text is a page title, not a topic of its own.
 */
function titlePremise(page, kind) {
  const parts = ['A web page the user has open.'];
  parts.push(`Its title is: ${page.title}.`);
  if (page.domain) parts.push(`It is on the site ${page.domain}.`);
  if (kind && kind !== 'unknown') parts.push(`It is a ${kind} page.`);
  return parts.join(' ');
}

/** Premise for one search row: a description *about* the page, not a page of its own. */
function contextPremise(row) {
  const parts = [];
  parts.push(`A web search about this page returned a result titled "${row.title}".`);
  if (row.snippet) parts.push(`That result says: ${row.snippet}`);
  return parts.join(' ');
}

function softmax(arr) {
  const m = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

function clamp01(x) {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function configureEnv(env, wasmUrl, allowRemote) {
  env.allowRemoteModels = allowRemote;
  env.allowLocalModels = true;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = wasmUrl;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

// ---- Transformers.js generative (in-browser, optional) -----------------------------------------

export class TransformersJsAdapter extends LocalLLM {
  constructor(generator, modelVersion = LLM_MODEL_VERSION) {
    super();
    this.generator = generator;
    this.version = modelVersion;
  }

  get modelVersion() {
    return this.version;
  }

  async complete(messages, { maxNewTokens = DEFAULT_MAX_NEW_TOKENS } = {}) {
    const tokenizer = this.generator.tokenizer;
    const prompt = tokenizer.apply_chat_template
      ? tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true })
      : messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:';
    const out = await this.generator(prompt, { max_new_tokens: maxNewTokens, do_sample: false, return_full_text: false });
    const text = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
    return typeof text === 'string' ? text : String(text ?? '');
  }

  async dispose() {
    try {
      await this.generator?.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Loads the ONNX model through the bundled Transformers.js. Weights are fetched once from the
 * Hugging Face hub (optional host permission) and kept in the browser Cache API.
 */
export async function loadTransformersJsLLM({ transformersUrl, wasmUrl, modelId = LLM_MODEL_ID, onProgress, allowRemote = true }) {
  const { pipeline, env } = await import(transformersUrl);
  configureEnv(env, wasmUrl, allowRemote);
  const generator = await pipeline('text-generation', modelId, { quantized: true, dtype: 'q4', progress_callback: onProgress });
  return new TransformersJsAdapter(generator, `${modelId}@q4`);
}

// ---- Ollama (localhost) ------------------------------------------------------------------------

export class OllamaAdapter extends LocalLLM {
  constructor({ endpoint = 'http://localhost:11434', model = 'qwen3:0.6b', contextLength = 4096, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    super();
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    this.contextLength = contextLength;
    this.fetchImpl = fetchImpl;
    assertLocal(this.endpoint);
  }

  get modelVersion() {
    return `ollama:${this.model}`;
  }

  async complete(messages, { maxNewTokens = DEFAULT_MAX_NEW_TOKENS, signal } = {}) {
    const res = await this.fetchImpl(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // num_ctx is explicit: the primed prompt is ~2k tokens and several Ollama builds default
      // to 2048, which would silently truncate the instructions before the payload.
      body: JSON.stringify({ model: this.model, messages, stream: false, format: 'json', options: { temperature: 0, num_predict: maxNewTokens, num_ctx: this.contextLength } }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
    const data = await res.json();
    return String(data?.message?.content ?? '');
  }
}

// ---- llama.cpp server (OpenAI-compatible, localhost) -------------------------------------------

export class LlamaCppAdapter extends LocalLLM {
  constructor({ endpoint = 'http://localhost:8080', model = 'local', fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    super();
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    this.fetchImpl = fetchImpl;
    assertLocal(this.endpoint);
  }

  get modelVersion() {
    return `llamacpp:${this.model}`;
  }

  async complete(messages, { maxNewTokens = DEFAULT_MAX_NEW_TOKENS, signal } = {}) {
    const res = await this.fetchImpl(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, temperature: 0, max_tokens: maxNewTokens, response_format: { type: 'json_object' } }),
      signal,
    });
    if (!res.ok) throw new Error(`llama.cpp server responded ${res.status}`);
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content ?? '');
  }
}

/** Cache-key identity of the runtime selected in settings (without loading anything). */
export function runtimeModelVersion(settings = {}) {
  if (settings.llmRuntime === 'ollama') return `ollama:${settings.llmModelName || 'qwen3:0.6b'}`;
  if (settings.llmRuntime === 'llamacpp') return `llamacpp:${settings.llmModelName || 'local'}`;
  if (settings.llmRuntime === 'transformers') return LLM_MODEL_VERSION;
  return NLI_MODEL_VERSION;
}

/** Runtime adapters must point at this machine; refuse anything else so no data leaves it. */
export function assertLocal(endpoint) {
  let host;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error(`Invalid LLM endpoint: ${endpoint}`);
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error(`LLM endpoint must be local, got ${host}`);
}
