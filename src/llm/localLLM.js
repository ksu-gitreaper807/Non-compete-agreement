/**
 * LocalLLM runtime abstraction. The classifier depends on this interface only; concrete
 * adapters wrap a specific local runtime. No adapter ever calls a cloud API.
 *
 *   LocalLLM
 *     ├── TransformersJsAdapter   in-extension ONNX/WASM (default; weights cached by the browser)
 *     ├── OllamaAdapter           http://localhost:11434 (user-run local server)
 *     └── LlamaCppAdapter         llama.cpp `llama-server` OpenAI-compatible endpoint on localhost
 */

export const LLM_MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
export const LLM_MODEL_VERSION = `${LLM_MODEL_ID}@q4`;
export const DEFAULT_MAX_NEW_TOKENS = 120;

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

// ---- Transformers.js (in-browser) ---------------------------------------------------------------

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
  env.allowRemoteModels = allowRemote;
  env.allowLocalModels = true;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = wasmUrl;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
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
  return LLM_MODEL_VERSION;
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
