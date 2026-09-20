/**
 * Local instruction-tuned LLM via Transformers.js (text-generation pipeline). Weights are
 * fetched once from the Hugging Face hub on first use and cached by the browser's Cache API;
 * afterwards inference is fully local. Only ONNX/WASM is used — no remote inference.
 *
 * Default: onnx-community/Qwen2.5-0.5B-Instruct (q4). Qwen3-0.6B needs Transformers.js v3;
 * swap `LLM_MODEL_ID` and upgrade vendor/transformers.min.js to use it.
 */
export const LLM_MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
export const LLM_MODEL_VERSION = `${LLM_MODEL_ID}@q4`;

export async function loadLlmModel({ transformersUrl, wasmUrl, modelId = LLM_MODEL_ID, onProgress, allowRemote = true }) {
  const { pipeline, env } = await import(transformersUrl);
  env.allowRemoteModels = allowRemote;
  env.allowLocalModels = true;
  env.useBrowserCache = true; // keep the downloaded weights in Cache storage
  env.backends.onnx.wasm.wasmPaths = wasmUrl;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;

  const generator = await pipeline('text-generation', modelId, { quantized: true, dtype: 'q4', progress_callback: onProgress });
  return new LlmModel(generator);
}

export class LlmModel {
  constructor(generator) {
    this.generator = generator;
  }

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @returns {Promise<string>} assistant text
   */
  async chat(messages, { maxNewTokens = 40 } = {}) {
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
