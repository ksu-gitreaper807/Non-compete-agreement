# Classification architecture

This document describes exactly how GoalGuard decides whether a tab is relevant to the weekly
goal, in the order the code executes it. File references are relative to `src/`.

## 0. Inputs and normalisation (`utils/text.js`, `background/controller.js`)

| Field | Source | Processing |
| --- | --- | --- |
| `url` | `tabs.Tab.url` | parsed with `new URL`; only `http:`, `https:`, `file:` continue |
| `domain` | hostname | lower-cased, leading `www.` removed |
| `title` | `tabs.Tab.title` | whitespace collapsed, zero-width chars removed, ≤300 chars |
| `text` | title, else URL words | `/watch/linux-virtual-memory` → `watch linux virtual memory` |

Pages with no goal set, or with neither a title nor readable URL words, produce
`classification: "unknown"` (`source: no-goal` / `no-title`) and never touch the model.

A per-domain+text classification cache (LRU, 1000 entries, in memory) short-circuits repeated
visits. It is cleared whenever settings, rules or anchors change.

## 1. Layer 1 — deterministic rules (`classifier/regexClassifier.js`)

The haystack is `lower(title + " " + url)`. Evaluation order (first hit wins):

| # | Check | Result | `source` |
| --- | --- | --- | --- |
| 1 | `settings.blockedDomains` (domain or subdomain match) | irrelevant | `rule:block-domain` |
| 2 | `rules.block[]` regexes | irrelevant | `rule:block` |
| 3 | `settings.allowedDomains` | relevant | `rule:allow-domain` |
| 4 | `rules.allow[]` regexes | relevant | `rule:allow` |
| 5 | built-in `AUTO_BLOCK_PATTERNS` (netflix.com, twitch.tv, tiktok.com, …) | irrelevant | `auto:block` |
| 6 | goal phrases (≥4 chars, whole-word, title only) | relevant | `auto:allow` |
| — | none | *fall through* | — |

Rationale: explicit user intent beats heuristics, and "block" beats "allow" so a user can always
carve exceptions out of an allow list. Because step 6 only looks at the title, a URL that merely
contains a goal word does not auto-allow.

Regex safety: patterns are compiled once per rule-set change with flags `iu` (falling back to
`i`); compile errors are collected in `invalid[]` and skipped. Patterns longer than 500 chars
are rejected at save time. `lastIndex` is reset before each test.

## 2. Layer 2 — semantic embeddings (`classifier/embeddingClassifier.js`)

### Anchors (`classifier/anchors.js`)

```
positiveAnchors = phrases(goal) ∪ expansions(phrases) ∪ {goal}
negativeAnchors = user list, default = generic distraction topics
```

`phrases()` strips leading verbs ("study", "learn", "finish my"…) and splits on
`, ; and & / plus`. `expansions()` consults a small keyword table
(`"operating system" → process management, virtual memory, file systems, linux kernel, …`).
Anchors are regenerated when the goal changes unless the user edited them; both lists are
editable in Options. Anchor embeddings are computed once and cached in memory.

### Scoring

```
v          = embed(text)                               // 384-d, L2-normalised (CLS pooling)
pos, iPos  = max_i cosine(v, positive[i])
neg, iNeg  = max_j cosine(v, negative[j])
raw        = pos − neg                                 // typically −0.25 … +0.35
score      = clamp(0.5 + SCORE_GAIN·raw, 0, 1)         // SCORE_GAIN = 2.5
```

`score = 0.5` means the title is as close to the nearest distraction topic as to the nearest
goal topic. The gain is presentational; thresholds could equally be expressed on `raw`.

### Thresholding (pure function `classifyScore`)

```
score ≥ settings.relevantThreshold     (0.65) → relevant     confident
score ≥ settings.questionableThreshold (0.45) → questionable confident=false
else                                          → irrelevant   confident
```

### Result object

```json
{
  "classification": "questionable",
  "score": 0.485,
  "positiveSimilarity": 0.509,
  "negativeSimilarity": 0.515,
  "goalSimilarity": 0.492,
  "nearestPositive": "study operating systems and c++",
  "nearestNegative": "gossip and viral news",
  "source": "embedding",
  "reason": "Between \"study operating systems and c++\" and \"gossip and viral news\"",
  "confident": false,
  "trace": [{ "classifier": "regex", "decided": false }, { "classifier": "embedding", "decided": true }]
}
```

### Failure modes

`ModelManager.isAvailable()` returns false for five minutes after a load failure; the
embedding classifier then returns `null`, the pipeline falls back to
`unknown / source: fallback`, and the default policy allows the page. Any exception inside a
classifier is caught by `ClassifierPipeline`, recorded in `trace`, and the next layer runs.

## 3. Policy (`classifier/policyEngine.js`)

```
decision        = settings.policy[classification]            // allow | warn | block
frictionSeconds = allow → 0
                  block → settings.frictionSeconds
                  warn  → questionableFrictionMode: none → 0
                                                    short → questionableFrictionSeconds
                                                    normal → frictionSeconds
overrideMinutes = settings.overrideMinutes
settings.enabled === false → always allow
```

## 4. Enforcement (`background/controller.js`, `blocking/frictionManager.js`)

```
requiresFriction(policy) && no active grant for domain
   → friction.startCountdown(domain)        (idempotent; keeps an existing unlockAt)
   → tabs.update(tabId, blocked.html?url&domain&title&classification&decision&score&tabId)
   → session tracking stopped (friction page is not screen time)
else
   → session tracking started with { classification, overridden: !!grant }
```

Friction state machine per domain:

```
BLOCKED ──startCountdown──► COUNTING_DOWN ──(now ≥ unlockAt)──► UNLOCKED ──grantAccess──► TEMPORARILY_ALLOWED
   ▲                              │                                 │                              │
   └────── abandon / tab closed ◄─┘          (2-min grace expiry) ◄─┘        (expiresAt reached) ◄─┘
```

`grantAccess` is the only transition that can produce a grant and it verifies `now ≥ unlockAt`
against the persisted timestamp — not against anything the page sends.

## 5. Model execution (`model/embeddingModel.js`, `model/modelManager.js`)

* Transformers.js is loaded via dynamic `import(runtime.getURL('vendor/transformers.min.js'))`
  inside the event page. ONNX Runtime's WASM binary is served from `vendor/ort/` under the
  extension's own origin; CSP includes `'wasm-unsafe-eval'` for that reason.
* `env.allowRemoteModels = false`, `env.localModelPath = runtime.getURL('models/')`,
  browser Cache API disabled (files are already local), one WASM thread, no proxy worker.
* Pipeline: `feature-extraction`, `{ pooling: 'cls', normalize: true }`, int8 weights.
* `ModelManager` loads lazily on the first `embed()` call, shares one in-flight promise between
  concurrent callers, keeps the model resident, and caches
  `FNV-1a(lower(normalisedTitle)) → Float32Array(384)` in a 500-entry LRU that is persisted
  (rounded to 4 decimals) to `storage.local` five seconds after changes.

Measured on the development machine (Node 22, x86-64, single WASM thread): model load
≈ 0.4 s, inference 6–9 ms per title, resident memory ≈ +195 MB RSS.

## 6. Extending with an LLM

```js
import { Classifier, makeResult } from './classifier.js';

export class LLMClassifier extends Classifier {
  get name() { return 'llm'; }
  async classify(context) {
    if (context.previous?.confident !== false) return null;   // only resolve ambiguity
    const verdict = await this.model.judge({ goal: context.goal, title: context.text });
    return makeResult(verdict.classification, 'llm', verdict.reason, { score: verdict.score });
  }
}
```

Register it after `EmbeddingClassifier` in `background/background.js`. `ClassifierPipeline`
already treats results with `confident: false` as tentative: it passes them to the next layer
as `context.previous` and only returns them if no later layer produces a confident result.
