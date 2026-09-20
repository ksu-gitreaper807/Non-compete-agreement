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
    const hypothesis = `This page is about ${payload.goal}.`;
    const titlePremise = payload.page.domain ? `${payload.page.title} (${payload.page.domain})` : payload.page.title;

    const scored = [{ text: payload.page.title, premise: titlePremise, kind: 'title' }];
    for (const r of payload.webContext ?? []) scored.push({ text: r.title, premise: r.snippet ? `${r.title}: ${r.snippet}` : r.title, kind: 'context' });
    for (const item of scored) item.p = clamp01(await this.entail(item.premise, hypothesis));

    // Web context, when present, describes the page better than a bare title: weight it 2:1.
    const context = scored.filter((s) => s.kind === 'context');
    const titleP = scored[0].p;
    const contextP = context.length ? context.reduce((a, s) => a + s.p, 0) / context.length : null;
    const p = contextP === null ? titleP : (2 * contextP + titleP) / 3;

    let classification = 'questionable';
    if (p >= this.thresholds.relevant) classification = 'relevant';
    else if (p <= this.thresholds.irrelevant) classification = 'irrelevant';
    // Confidence = how far the entailment probability sits from the undecided middle (0.5).
    const confidence = round2(Math.min(1, Math.abs(p - 0.5) * 2));
    const evidence = classification === 'questionable' ? [] : scored.filter((s) => (classification === 'relevant' ? s.p >= this.thresholds.relevant : s.p <= this.thresholds.irrelevant)).map((s) => s.text).slice(0, 3);
    const reason = classification === 'relevant'
      ? `Page context entails the goal (${Math.round(p * 100)}% entailment).`
      : classification === 'irrelevant'
        ? `Page context does not entail the goal (${Math.round(p * 100)}% entailment).`
        : `Entailment is undecided (${Math.round(p * 100)}%).`;
    return JSON.stringify({ classification, confidence, reason, evidence, entailment: round2(p) });
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

function parsePayload(messages) {
  try {
    return JSON.parse(messages?.[1]?.content ?? messages?.[0]?.content ?? '{}');
  } catch {
    return null;
  }
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
  constructor({ endpoint = 'http://localhost:11434', model = 'qwen3:0.6b', fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    super();
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
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
      body: JSON.stringify({ model: this.model, messages, stream: false, format: 'json', options: { temperature: 0, num_predict: maxNewTokens } }),
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
