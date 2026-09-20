# GoalGuard — goal-based screen time for Firefox

GoalGuard is a privacy-first Firefox extension that decides whether the tab you are looking at
is relevant to your **weekly goal** and adds deliberate friction when it is not.

```
"Study operating systems and C++"

  OSTEP - Processes                 → relevant      → opens immediately
  Linux Virtual Memory Explained    → relevant      → opens immediately
  Linus Torvalds Interview          → questionable  → short pause, then Continue
  Best Gaming PCs of 2026           → irrelevant    → 10 s pause, then 5 min of access
```

Classification is **semantic, not domain based** — YouTube is fine for a lecture and gets
friction for gaming videos — and it runs **entirely on your machine** with a 33 MB int8 copy
of `BGE-small-en-v1.5` bundled inside the extension. No cloud API, no telemetry, no network
traffic at all.

---

## Contents

1. [Project overview](#project-overview)
2. [Architecture](#architecture)
3. [Installation](#installation)
4. [Development](#development)
5. [Model information](#model-information)
6. [Privacy](#privacy)
7. [Classification algorithm](#classification-algorithm)
8. [Threshold configuration](#threshold-configuration)
9. [Friction and timed override](#friction-and-timed-override)
10. [Data model](#data-model)
11. [Testing](#testing)
12. [Benchmark](#benchmark)
13. [Known limitations](#known-limitations)
14. [Future LLM integration](#future-llm-integration)

---

## Project overview

The core loop:

```
tab changes ─► normalise title/URL ─► classification cache
                                          │ miss
                                          ▼
                              Layer 1: deterministic rules
                              (user block → user allow → auto block → goal terms)
                                          │ no rule fired
                                          ▼
                              Layer 2: BGE-small embeddings
                              cosine vs positive & negative anchors
                                          │
                                          ▼
                     RELEVANT / QUESTIONABLE / IRRELEVANT  (thresholds from settings)
                                          │
                                          ▼
                              Policy engine → ALLOW / WARN / BLOCK
                                          │
                     ALLOW ───────────────┼────────────── WARN / BLOCK
                       │                                    │
                  immediate access              friction page + authoritative countdown
                                                            │
                                                Continue → domain-scoped timed access
```

Everything the user sees is a **view** of background state; the background event page is the
sole authority on countdowns and grants, so reloading, re-opening or editing the friction page
cannot shorten a wait.

## Architecture

```
goalguard/
├── manifest.json                 MV3, Firefox event page (background.scripts + type: module)
├── src/
│   ├── background/
│   │   ├── background.js         wiring, message handlers, alarms, lifecycle
│   │   ├── controller.js         per-tab pipeline (cache → classifiers → policy → friction)
│   │   ├── tabMonitor.js         tabs/windows/idle listeners, debounce
│   │   ├── sessionTracker.js     screen-time accounting, day buckets, session log
│   │   └── messageRouter.js      runtime.onMessage dispatcher with error envelopes
│   ├── classifier/
│   │   ├── classifier.js         Classifier interface + ClassifierPipeline
│   │   ├── regexClassifier.js    Layer 1 rules and precedence
│   │   ├── embeddingClassifier.js Layer 2 similarity scoring + pure threshold function
│   │   ├── anchors.js            goal → positive/negative anchor generation (local heuristics)
│   │   ├── similarity.js         dot / norm / cosine / max-similarity
│   │   └── policyEngine.js       classification → decision + friction parameters
│   ├── model/
│   │   ├── embeddingModel.js     Transformers.js wrapper (CLS pooling, L2 normalise)
│   │   └── modelManager.js       lazy load, single instance, LRU embedding cache, status
│   ├── blocking/
│   │   ├── frictionManager.js    authoritative countdown / grant state machine
│   │   └── blocker.js            friction page URL helpers
│   ├── storage/
│   │   ├── schema.js             defaults, enums, day/week keys
│   │   └── storage.js            browser.storage.local wrapper with in-memory fallback
│   └── utils/  text.js · regex.js · lruCache.js
├── popup/                        goal, current verdict, today's stats, weekly progress
├── options/                      goal, thresholds, policy, friction, rules, anchors, model
├── blocking/                     friction page (blocked.html/js/css)
├── models/bge-small-en-v1.5/     tokenizer + int8 ONNX graph (bundled, ~34 MB)
├── vendor/                       transformers.min.js 2.17.2 + onnxruntime-web WASM
├── tests/  unit/ · model/ · integration/ · data/titles.json · helpers/
├── scripts/  benchmark.mjs · check-manifest.mjs · package.mjs
└── docs/CLASSIFICATION.md        detailed algorithm documentation
```

**Why an MV3 event page and not a service worker?** Firefox supports `background.scripts`
under Manifest V3 (an event page). Unlike Chrome's service worker it can run WebAssembly ONNX
inference directly and keeps globals alive across events, so the model stays loaded between
tab switches. All authoritative state is nonetheless persisted to `storage.local`, so the
extension survives event-page termination without losing countdowns, grants or statistics.

## Installation

### Temporary install (development)

1. `git clone` this repository (no build step is required — the extension runs from source).
2. Open Firefox (115 or newer) and go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select `manifest.json` in the repository root.
4. The options page opens automatically. Enter a weekly goal and save.
5. Click the GoalGuard toolbar icon to see the verdict for the current tab.

Temporary add-ons are removed when Firefox restarts; repeat step 3 to reload.

### Packaged install

```bash
npm run package        # → dist/goalguard-0.1.0.zip (≈27 MB)
```

Load the zip via **Load Temporary Add-on…**, or sign it through
[addons.mozilla.org](https://addons.mozilla.org/developers/) for a permanent install
(Firefox Developer Edition / Nightly can install unsigned zips with
`xpinstall.signatures.required = false`).

### Permissions requested

| Permission | Why |
| --- | --- |
| `tabs` | read the active tab's URL and title |
| `storage`, `unlimitedStorage` | settings, statistics, embedding cache |
| `alarms` | flush screen time and expire temporary grants once a minute |
| `idle` | stop counting screen time when you walk away |

No host permissions, no content scripts, no network access.

## Development

```bash
npm install            # dev dependency only: @xenova/transformers for Node tests/benchmarks
npm test               # unit + model + integration tests (Node ≥ 20)
npm run benchmark      # accuracy + latency + memory on tests/data/titles.json
npm run lint:manifest  # verifies every referenced asset exists and CSP allows WASM
npm run package        # zip for distribution
```

There is no bundler or transpiler; every file is a plain ES module Firefox loads directly.

Debugging tips: in `about:debugging` click **Inspect** next to GoalGuard to open the background
console. Every classification exposes its full result (`score`, `positiveSimilarity`,
`negativeSimilarity`, `source`, `reason`) through the popup and through
**Options → Thresholds → Try a title**.

## Model information

| | |
| --- | --- |
| Model | `BAAI/bge-small-en-v1.5` (via the `Xenova/bge-small-en-v1.5` ONNX export) |
| Size on disk | 33.8 MB (int8 dynamic quantisation) + 0.7 MB tokenizer |
| Output | 384-dimensional, CLS-pooled, L2-normalised |
| Runtime | Transformers.js 2.17.2 → onnxruntime-web (WASM, single thread) |
| Loading | lazy — first uncertain title triggers the load; then kept resident |
| Measured (dev machine, Node 22, x86-64) | load ≈ 0.4 s · inference ≈ 7 ms/title (p95 9 ms) · RSS +195 MB |

The model files are **inside the extension package** (`models/`). Nothing is fetched from
Hugging Face or anywhere else at runtime, which is why `env.allowRemoteModels = false` is set
in `src/model/embeddingModel.js`. See `models/README.md` for provenance and how to regenerate.

If loading fails (e.g. WASM disabled), the model manager reports `unavailable`, the popup shows
**AI classifier: unavailable**, and pages that reach Layer 2 are classified `unknown`, which the
default policy **allows**. Rules keep working. Loading is retried after 5 minutes.

## Privacy

GoalGuard is built so that it *cannot* leak data:

* Classification runs locally in the extension's own process.
* Page titles, URLs and browsing history are **never uploaded**.
* No AI API, no analytics SDK, no telemetry, no remote configuration.
* The extension requests **no host permissions** and makes **no `fetch` calls**.
* Stored data is minimal: settings, rules, anchors, per-day counters, a bounded list of
  recent sessions (domain + truncated title + classification + duration; **no URLs**), and a
  bounded cache of `hash(title) → embedding`.
* Everything lives in `browser.storage.local` and is deleted with **Options → Reset** or by
  uninstalling.

The manifest declares `data_collection_permissions: { required: ["none"] }` for AMO.

## Classification algorithm

Full details in [`docs/CLASSIFICATION.md`](docs/CLASSIFICATION.md). Summary:

**Input.** `title` (whitespace-normalised, ≤300 chars) or, when empty, readable words from the
URL path. Unsupported schemes (`about:`, `moz-extension:`, …) are ignored entirely.

**Layer 1 — deterministic rules** (`regexClassifier.js`), first match wins:

1. user **blocked domains** / **block regexes** → `irrelevant`
2. user **allowed domains** / **allow regexes** → `relevant`
3. built-in auto-block hosts (Netflix, Twitch, TikTok, …) → `irrelevant`
4. a literal goal phrase (≥4 chars, whole word) in the title → `relevant`
5. otherwise → next layer

Regexes are compiled with `i`+`u` flags; invalid patterns are reported and skipped, never thrown.

**Layer 2 — embeddings** (`embeddingClassifier.js`):

```
positiveSimilarity = max cosine(title, positiveAnchors ∪ {goal})
negativeSimilarity = max cosine(title, negativeAnchors)
score              = clamp(0.5 + 2.5 × (positiveSimilarity − negativeSimilarity), 0, 1)

score ≥ relevantThreshold      → RELEVANT
score ≥ questionableThreshold  → QUESTIONABLE
otherwise                      → IRRELEVANT
```

Anchors are generated locally from the goal (`anchors.js`: phrase splitting + a small topic
expansion table) and are fully editable in Options. Negative anchors default to generic
distraction topics (gaming, celebrity news, shopping, social feeds, …).

Every result stores `classification`, `score`, `positiveSimilarity`, `negativeSimilarity`,
`goalSimilarity`, `nearestPositive`, `nearestNegative`, `source` and `reason`.

**Policy engine** (`policyEngine.js`) maps classification → `allow | warn | block` and picks
the friction duration. Defaults: relevant→allow, questionable→warn (short friction),
irrelevant→block (normal friction), unknown→allow. All configurable.

## Threshold configuration

Thresholds live in settings, not in code:

| Setting | Default | Meaning |
| --- | --- | --- |
| `relevantThreshold` | 0.65 | score at or above → relevant |
| `questionableThreshold` | 0.45 | score at or above → questionable |

`SCORE_GAIN = 2.5` in `embeddingClassifier.js` only rescales the similarity gap so that the
useful range of BGE cosine differences (≈ ±0.2) spreads over 0–1; a score of 0.5 means "equally
close to the goal and to distractions".

The defaults were picked by sweeping the benchmark (see below); they are **heuristics, not
validated values**. Use *Options → Try a title* to inspect scores for your own goal and adjust.

## Friction and timed override

Implemented in `src/blocking/frictionManager.js`; the friction page is a dumb view.

```
open distracting site
   ▼
background: startCountdown(domain)       unlockAt = now + frictionSeconds   (persisted)
   ▼
blocked.html polls getFrictionState      shows remaining time; Continue disabled
   ▼
now ≥ unlockAt → UNLOCKED                Continue enabled (2-minute grace window)
   ▼
Continue → grantAccess(domain)           rejected unless now ≥ unlockAt
                                          grant = { grantedAt: now, expiresAt: now + overrideMinutes }
   ▼
TEMPORARILY_ALLOWED for that domain      time still counted as distraction + overrideMs
   ▼
expiry (alarm every minute)              open tabs on that domain re-enter friction
```

Guarantees:

* **Authoritative timestamps.** The page never decides; it only asks. Refreshing, reopening,
  DOM/CSS edits or re-triggering the redirect return the *same* `unlockAt`.
* **Domain scoped.** Grants are keyed by registrable host (`youtube.com` covers `m.youtube.com`).
* **Go Back** cancels the countdown and records `frictionAbandoned` — never screen time.
* **Questionable pages** use the same page in a visually distinct "warn" style with a
  relevance percentage; the policy decides `none | short | normal` friction.
* **Recovery.** If the background is unreachable the page shows a direct link to the original
  URL, so nobody is ever trapped. Disabling the extension in `about:addons` works normally.

Statistics per day: `frictionTriggered`, `frictionCompleted`, `frictionAbandoned`, `overrides`,
`overrideMs` (time spent after overrides), plus `relevantMs / questionableMs / irrelevantMs`.

## Data model

```jsonc
{
  "schemaVersion": 1,
  "settings": {
    "enabled": true,
    "weeklyGoal": "Study operating systems and C++",
    "weeklyTargetMinutes": 600,
    "relevantThreshold": 0.65,
    "questionableThreshold": 0.45,
    "frictionSeconds": 10,
    "questionableFrictionMode": "short",     // none | short | normal
    "questionableFrictionSeconds": 5,
    "overrideMinutes": 5,
    "policy": { "relevant": "allow", "questionable": "warn", "irrelevant": "block", "unknown": "allow" },
    "allowedDomains": [], "blockedDomains": []
  },
  "rules":   { "allow": ["\\bOSTEP\\b"], "block": ["\\bHelldivers\\b"] },
  "anchors": { "positive": ["operating systems", "virtual memory"], "negative": ["video games and gaming"], "generatedFromGoal": "…" },
  "friction": { "countdowns": { "pcmag.com": { "unlockAt": 0, "startedAt": 0, "tabId": 3 } },
                "grants":     { "youtube.com": { "grantedAt": 0, "expiresAt": 0 } } },
  "statistics": { "days": { "2026-09-20": { "relevantMs": 0, "irrelevantMs": 0, "overrideMs": 0, "frictionTriggered": 0, "overrides": 0 } } },
  "sessions": [ { "domain": "pcmag.com", "title": "Best Gaming PCs…", "classification": "irrelevant", "startedAt": 0, "endedAt": 0, "overridden": true } ],
  "currentSession": null,
  "embeddingCache": [ ["fnv1a-hash", [384 floats]] ]
}
```

Limits (`schema.js → DEFAULT_LIMITS`): 500 cached embeddings, 1000 cached classifications
(in memory), 2000 sessions / 14 days retention.

## Testing

```bash
npm test                 # everything (≈8 s)
npm run test:unit        # 63 tests, no model needed
npm run test:model       # real BGE model: embeddings, similarity ordering, fixture titles
npm run test:integration # boots the real background.js against a fake `browser` API
```

Coverage highlights:

* **Regex:** matching, non-matching, case-insensitivity, invalid patterns, full precedence chain,
  whole-word goal terms.
* **Similarity:** identical / orthogonal / opposite / zero vectors, argmax selection.
* **Embedding classifier:** pure threshold logic, positive/negative anchor scoring with a
  deterministic fake model, anchor caching, unavailable-model fall-through.
* **Friction manager:** countdown timing, early-Continue rejection, reload persistence, grant
  expiry, domain scoping, abandonment, tab cleanup, grace window.
* **Session tracker:** per-class accumulation, override accounting, midnight split, bounded logs.
* **Controller:** allow / block / warn flows, failing classifier is skipped, cache, ignored URLs.
* **Integration:** goal → anchors → relevant page allowed → irrelevant page redirected →
  countdown → Continue refused early / accepted later → grant → no re-redirect → statistics →
  revoke → re-friction; Go Back; user allow rule overriding the model; unsupported URLs.

Fixture set used by the model tests (functional, not scientific):

```
goal,title,expected
"Study operating systems and C++","OSTEP Processes",relevant
"Study operating systems and C++","Linux Virtual Memory",relevant
"Study operating systems and C++","Gaming PC Review",irrelevant
"Study operating systems and C++","Linus Torvalds Interview",questionable
```

## Benchmark

`tests/data/titles.json` holds 133 hand-labelled titles across six goals (operating systems,
C++, mathematics, machine learning, fitness, reading) and three classes
(60 relevant / 45 irrelevant / 28 ambiguous). `npm run benchmark` runs the real pipeline:

```
Three-way accuracy:          81.2%
                 relevant  questionable  irrelevant
  relevant             57             3           0
  questionable         13            10           5
  irrelevant            0             4          41

Block decision (irrelevant = positive, ambiguous excluded):
  accuracy 96.2%  precision 100.0%  recall 91.1%  F1 95.3%
  false-positive rate 0.0% (relevant pages wrongly blocked)
  false-negative rate 8.9% (irrelevant pages let through)

Performance:
  model load          ~400 ms
  raw inference       mean 7.2 ms, p50 7.0 ms, p95 9.3 ms
  RSS                 49 MB → 244 MB after load (Δ ≈ 195 MB, includes WASM heap + Node)
```

Options: `--relevant 0.7 --questionable 0.5 --no-regex --json out.json`. The script prints
every misclassified title so threshold or anchor changes can be judged concretely.

Ambiguous titles are the weak spot (only ~35 % land in *questionable*; most are pulled toward
*relevant* because they mention the topic). That is exactly the gap a future local LLM layer
is meant to fill.

## Known limitations

* **English only.** BGE-small-en is an English model; other languages will score poorly.
* **Title-only signal.** Pages with generic titles ("YouTube", "Home") are judged on the URL
  path; single-page apps that update titles late may be classified twice.
* **Thresholds are heuristics** tuned on a 133-title set by the author; calibrate per user.
* **Ambiguous content** skews relevant when the goal topic is mentioned (see benchmark).
* **Memory.** The resident model costs roughly 150–200 MB while loaded; it is loaded lazily
  and only when a title reaches Layer 2.
* **Friction, not DRM.** Private windows, other browsers, or disabling the add-on bypass it by
  design.
* **Event page restarts** reload the model on the next uncertain title (~0.4–1 s); the
  embedding cache is persisted to soften this.
* Developed and tested on Linux via automated tests against a faithful `browser` API stub and
  the real model; manual verification in a desktop Firefox profile is still recommended
  before wider use (see Installation).

## Future LLM integration

The pipeline is a list of `Classifier` instances (`src/classifier/classifier.js`):

```js
class Classifier { get name() {} async classify(context) {} }   // return result or null
```

`ClassifierPipeline` runs them in order; the embedding layer marks `QUESTIONABLE` results as
`confident: false`. Adding a local LLM (e.g. Qwen3-0.6B through Transformers.js or a native
messaging host) means:

1. `src/classifier/llmClassifier.js` implementing `classify(context)` that returns `null`
   unless the previous result was unconfident (the pipeline can pass the prior result in
   `context.previous`).
2. Registering it after `EmbeddingClassifier` in `background.js`.
3. Optionally implementing `AnchorGenerator.generate(goal)` in `anchors.js` with the LLM so
   positive/negative anchors are produced automatically.

No other module needs to change: policy, friction, tracking and UI consume the same
`ClassificationResult` shape.

## Acknowledgements

* [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT)
* [Transformers.js](https://github.com/xenova/transformers.js) (Apache-2.0) and
  [ONNX Runtime Web](https://onnxruntime.ai/) (MIT)
* Friction UX inspired by ScreenZen.
