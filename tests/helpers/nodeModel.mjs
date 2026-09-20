/**
 * Loads the bundled BGE-small model in Node for tests/benchmarks, using the same files the
 * extension ships. Mirrors src/model/embeddingModel.js but with Node paths.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbeddingModel } from '../../src/model/embeddingModel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadNodeModel() {
  const { pipeline, env } = await import('@xenova/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.join(root, 'models') + path.sep;
  env.useFSCache = false;
  env.backends.onnx.wasm.numThreads = 1;
  const extractor = await pipeline('feature-extraction', 'bge-small-en-v1.5', { quantized: true });
  return new EmbeddingModel(extractor);
}
