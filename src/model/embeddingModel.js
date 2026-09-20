/**
 * Wrapper around Transformers.js running BGE-small-en-v1.5 fully locally.
 *
 * The model files ship inside the extension (models/bge-small-en-v1.5) and ONNX Runtime's
 * WebAssembly binary ships in vendor/ort. No network access is required at any point.
 */

export const MODEL_ID = 'bge-small-en-v1.5';
export const EMBEDDING_DIMENSIONS = 384;

/**
 * @param {{ transformersUrl: string, modelsUrl: string, wasmUrl: string, onProgress?: Function }} options
 */
export async function loadEmbeddingModel({ transformersUrl, modelsUrl, wasmUrl, onProgress }) {
  const { pipeline, env } = await import(transformersUrl);

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsUrl;
  env.useBrowserCache = false; // files are already local; avoid a second copy in Cache storage
  env.useFSCache = false;
  env.backends.onnx.wasm.wasmPaths = wasmUrl;
  env.backends.onnx.wasm.numThreads = 1; // single-threaded avoids SharedArrayBuffer requirements
  env.backends.onnx.wasm.proxy = false;

  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    quantized: true,
    progress_callback: onProgress,
  });

  return new EmbeddingModel(extractor);
}

export class EmbeddingModel {
  constructor(extractor) {
    this.extractor = extractor;
  }

  /**
   * BGE uses CLS pooling with L2 normalisation. Returns a Float32Array(384).
   */
  async embed(text) {
    const input = String(text ?? '').trim() || ' ';
    const output = await this.extractor(input, { pooling: 'cls', normalize: true });
    const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
    if (data.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Unexpected embedding size ${data.length}`);
    }
    return data;
  }

  async dispose() {
    try {
      await this.extractor?.dispose?.();
    } catch {
      /* ignore */
    }
  }
}
