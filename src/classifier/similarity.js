/**
 * Vector math for embeddings. Kept dependency-free so it can be tested in isolation.
 */

export function dot(a, b) {
  if (!a || !b || a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a?.length} vs ${b?.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a) {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]. Returns 0 for zero vectors instead of NaN. */
export function cosineSimilarity(a, b) {
  const denominator = norm(a) * norm(b);
  if (denominator === 0) return 0;
  return dot(a, b) / denominator;
}

/** Returns a new Float32Array with unit length (or a copy if the norm is 0). */
export function normalize(a) {
  const n = norm(a);
  const out = new Float32Array(a.length);
  if (n === 0) return out;
  for (let i = 0; i < a.length; i++) out[i] = a[i] / n;
  return out;
}

/** Highest cosine similarity between `vector` and any vector in `candidates`. */
export function maxSimilarity(vector, candidates) {
  let best = -1;
  let bestIndex = -1;
  for (let i = 0; i < candidates.length; i++) {
    const s = cosineSimilarity(vector, candidates[i]);
    if (s > best) {
      best = s;
      bestIndex = i;
    }
  }
  return { similarity: bestIndex === -1 ? 0 : best, index: bestIndex };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
