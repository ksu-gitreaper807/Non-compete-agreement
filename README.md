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
of `BGE-small-en-v1.5` bundled inside the extension. No cloud API, no telemetry, and by
default no network traffic at all. An **optional** third layer (off by default) lets a small
local LLM resolve ambiguous pages, optionally grounded with a DuckDuckGo search.

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
│   │   ├── controller.js         per-tab handling (cache → DecisionPipeline → policy → friction), race guards, feedback
│   │   ├── tabMonitor.js         tabs/windows/idle listeners, debounce
│   │   ├── sessionTracker.js     screen-time accounting, day buckets, session log
│   │   └── messageRouter.js      runtime.onMessage dispatcher with error envelopes
│   ├── intelligence/
│   │   ├── decisionPipeline.js   THE central pipeline: rules → regex → BGE → [search] → [LLM] → evidence policy
│   │   └── telemetry.js          local-only latency/counter stats (p50/p95 per stage)
│   ├── classifier/
│   │   ├── classifier.js         Classifier interface (+ minimal sequential runner for tools)
│   │   ├── regexClassifier.js    Layer 1 rules and precedence
│   │   ├── embeddingClassifier.js Layer 2 similarity scoring + pure threshold function
│   │   ├── anchors.js            goal → positive/negative anchor generation (local heuristics)
│   │   ├── similarity.js         dot / norm / cosine / max-similarity
│   │   └── policyEngine.js       classification → decision + friction parameters
│   ├── model/
│   │   ├── embeddingModel.js     Transformers.js wrapper (CLS pooling, L2 normalise)
│   │   └── modelManager.js       lazy load, single instance, LRU embedding cache, status
│   ├── search/                   OPTIONAL web-context layer (context retrieval, not a classifier)
│   │   ├── searchProvider.js     SearchProvider interface + MockSearchProvider
│   │   ├── duckduckgoProvider.js DuckDuckGo HTML endpoint provider + parser
│   │   ├── queryBuilder.js       title → query, generic-title detection, URL sanitiser
│   │   ├── resultParser.js       normalise/dedupe, rank (BGE or lexical), evidence grading
│   │   ├── rateLimiter.js        min interval / per minute / per session
│   │   └── searchManager.js      cache → rate limit → provider → parse; never throws
│   ├── llm/                      OPTIONAL local-LLM layer
│   │   ├── localLLM.js           LocalLLM interface + TransformersJs / Ollama / llama.cpp adapters
│   │   ├── llmManager.js         lazy load, timeout, dedupe, idle unload, cool-down
│   │   ├── promptBuilder.js      structured payload (goal, page, similarities, web context)
│   │   ├── responseParser.js     strict JSON verdict validation + evidence grounding
│   │   └── llmClassifier.js      Classifier over the above with its own verdict cache
│   ├── blocking/
│   │   ├── frictionManager.js    authoritative countdown / grant state machine
│   │   └── blocker.js            friction page URL helpers
│   ├── storage/
│   │   ├── schema.js             defaults, enums, day/week keys
│   │   ├── storage.js            browser.storage.local wrapper with in-memory fallback
│   │   ├── cacheStore.js         PersistentCache: TTL + LRU + debounced persistence + dedupe
│   │   └── cacheKeys.js          versioned key builders and config fingerprint
│   └── utils/  text.js · regex.js · lruCache.js
├── popup/                        goal, verdict, "Why?", feedback, AI status, debug trace
├── options/                      goal, thresholds, policy, friction, rules, anchors, AI settings, caches, debug
├── blocking/                     friction page (blocked.html/js/css)
├── models/bge-small-en-v1.5/     tokenizer + int8 ONNX graph (bundled, ~34 MB)
├── vendor/                       transformers.min.js 2.17.2 + onnxruntime-web WASM
├── tests/  unit/ · model/ · integration/ · data/titles.json · helpers/
├── scripts/  benchmark.mjs · benchmark-layers.mjs · check-manifest.mjs · package.mjs
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

No required host permissions, no content scripts, no network access by default. Enabling the
optional AI layers requests `optional_host_permissions` (Hugging Face for the one-time model
download, `html.duckduckgo.com` for web context, `localhost` for an Ollama/llama.cpp runtime).

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
* The extension requests **no host permissions** by default and makes **no `fetch` calls**
  unless you opt in to layer 3. Then, and only then: the LLM weights are downloaded once from
  `huggingface.co`, and — if you also enable search — the page **title** (never the URL) is
  sent to `html.duckduckgo.com` for `questionable` pages. Both are `optional_host_permissions`
  that Firefox asks you to approve and that you can revoke in `about:addons`.
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

**Layer 3 — web context (opt-in)** (`src/search/`): *context retrieval, not a classifier*.
Reached only when Layer 2 was not confident and the LLM is enabled. `queryBuilder` turns the
title into a query (title only; the domain is appended for generic titles like "Episode 42";
the goal is never sent), `SearchManager` checks the 24 h retrieval cache, applies the rate
limiter (≥2 s apart, ≤10/min, ≤300/session), calls the `SearchProvider` (DuckDuckGo HTML), and
`resultParser` reduces the answer to ≤5 `{title, url, domain, snippet, relevance}` rows ranked by
BGE similarity to the page title, with an `evidenceQuality` grade (`high|medium|low|none`).
*Search on:* "only highly ambiguous titles" (default) or "all uncertain pages".

**Layer 4 — local LLM (opt-in)** (`src/llm/`): receives a structured JSON payload (goal, page
title + domain, the three similarity numbers, web context) under a fixed system prompt and must
answer strict JSON `{classification, confidence, reason, evidence}`. `responseParser` rejects
anything else; evidence phrases not present in the supplied context are dropped. Verdicts are
cached per (model, goal, title, domain, context) so a page costs one generation.

**Evidence-aware finalisation** (`decisionPipeline.js`): the LLM's confidence is not trusted
blindly — `confidence < llmMinConfidence` (0.6) or a definite verdict with `evidenceQuality:
none` is downgraded to `questionable`. Every result records `source`, `sourceKind`
(`explicit_rule | regex | embedding | local_llm | fallback`), `confidence`, `semanticScore`,
`evidenceQuality`, `searchUsed` and per-stage `timings`.

Runtimes: in-browser Transformers.js (`onnx-community/Qwen2.5-0.5B-Instruct` q4, ≈400 MB
downloaded once; Qwen3-0.6B needs Transformers.js v3), or a **localhost** Ollama / llama.cpp
server (e.g. `qwen3:0.6b`) — adapters refuse any non-local endpoint.

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

## Caching

Four independent persistent caches (`src/storage/cacheStore.js`), each its own
`storage.local` key (`cache:classification`, `cache:embedding`, `cache:retrieval`, `cache:llm`), loaded
into memory once and written back debounced (3 s after a change; 15 s for recency-only
updates; also flushed by the minute alarm).

| Namespace | Key | TTL | Max entries | Value |
| --- | --- | --- | --- | --- |
| `classification` | `cls:v1:<config-fingerprint>:<domain>:<normalised title>` | 7 days | 2000 | final result (classification, score, similarities, source, reason) |
| `embedding` | `emb:v1:<model-version>:<hash(normalised title)>` | 30 days | 500 | Float32Array(384), stored as 4-decimal numbers |
| `retrieval` | `ret:v2:ddg:<normalised query>` | 24 hours (configurable) | 300 | `{query, timestamp, results: {title, url, domain, snippet}[]}` |
| `llm` | `llm:v1:<model>:<hash(goal, title, domain, context)>` | 7 days | 1000 | parsed LLM verdict `{classification, confidence, reason, evidence}` |

Options offers *Clear search cache* and *Clear AI classification cache* separately. Feedback
entries (`feedback` key, ≤2000, domain + title + labels, no URL) are separate from caches.

Constants live in `CACHE_DEFAULTS` (`FINAL_CLASSIFICATION_TTL`, `EMBEDDING_TTL`,
`SEARCH_RESULT_TTL`, `MAX_*_CACHE_ENTRIES`).

* **Key normalisation** (`normalizeTitleForKey`): NFKC, lower-case, typographic quotes/dashes
  unified, whitespace collapsed, decorative edge punctuation trimmed. Internal punctuation is
  kept (`C++` ≠ `C`). Domains are lower-cased without `www.`; URLs are never part of a key, so
  `watch?v=A` and `watch?v=B` with the same title share one entry while different titles do not.
* **Invalidation.** The classification key embeds a fingerprint of goal, thresholds, domain
  lists, regex rules, anchors and `MODEL_VERSION` (`bge-small-en-v1.5-int8`). Changing any of
  them makes old entries unreachable; they age out via TTL/LRU. Bumping a `*_KEY_VERSION` or
  `CACHE_SCHEMA_VERSION` invalidates everything at once. *Options → Caches → Clear* wipes them.
* **Eviction** happens only on insert: expired entries first, then least-recently-used.
* **Deduplication.** `getOrCompute` shares one in-flight promise per key, so two tabs opening
  the same page trigger one pipeline run and one embedding inference.
* **Observability.** Set `DEBUG_CACHE = true` in `background.js` (or
  `globalThis.GOALGUARD_DEBUG_CACHE`) for `[CACHE] classification HIT/MISS/expired/evicted`
  lines; Options shows live hit/miss/evict counters.
* **Privacy.** Cached values contain domain + normalised title + scores. No URLs, no page bodies.

A cache hit answers *what the page is*; it never answers *whether the user has waited*. Friction
state is separate and per tab (below).

## Friction and timed override

Implemented in `src/blocking/frictionManager.js`; the friction page is a dumb view.

```
open distracting site (tab 12)
   ▼
background: startCountdown(tabId 12)     unlockAt = now + frictionSeconds, generation = n  (persisted)
   ▼
blocked.html polls getFrictionState      shows remaining time; Continue disabled
   │
   ├─ user switches tab / window blurs → onTabDeactivated(12): running countdown deleted
   │      return → getFrictionState starts a *fresh full* countdown, generation = n+1
   │
   ├─ tab navigates to another page     → countdown deleted (hash-only changes are the same page)
   ▼
now ≥ unlockAt → UNLOCKED                Continue enabled (2-minute grace window); tab switches
                                          no longer reset it — completion wins
   ▼
Continue → grantAccess(tab, generation)  rejected unless now ≥ unlockAt AND generation is current
                                          grant = { domain, grantedAt: now, expiresAt: now + overrideMinutes }
   ▼
TEMPORARILY_ALLOWED for that domain      time still counted as distraction + overrideMs
   ▼
expiry (alarm every minute)              open tabs on that domain re-enter friction
```

Guarantees:

* **Authoritative timestamps.** The page never decides; it only asks. Refreshing the friction
  page returns the *same* `unlockAt`; DOM/CSS edits change nothing.
* **Per-tab timers, tab-switch reset.** `tabs.onActivated` / `windows.onFocusChanged` tell the
  controller which tab is in front. A countdown that is still running on the tab you left is
  invalidated (not paused): coming back means the full delay again. Rapid switching therefore
  can never accumulate progress. A background tab's friction page is told `inactive` and cannot
  start a timer until it is active.
* **Generations against races.** Every (re)start increments `generation`. The page sends the
  generation it saw; `grantAccess` refuses stale ones, so a callback from a timer that was reset
  milliseconds earlier cannot grant access. Completion is checked against the persisted
  `unlockAt`, so if the timer finished before the switch, the switch does not undo it.
* **Domain scoped grants.** Grants are keyed by registrable host (`youtube.com` covers
  `m.youtube.com`) and are independent of tabs.
* **Go Back** cancels the countdown and records `frictionAbandoned` — never screen time.
* **Questionable pages** use the same page in a visually distinct "warn" style with a
  relevance percentage; the policy decides `none | short | normal` friction.
* **Recovery.** If the background is unreachable the page shows a direct link to the original
  URL, so nobody is ever trapped. Disabling the extension in `about:addons` works normally.

Statistics per day: `frictionTriggered`, `frictionCompleted`, `frictionAbandoned`, `frictionReset`, `overrides`,
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
  "friction": { "countdowns": { "3": { "tabId": 3, "domain": "pcmag.com", "url": "…", "generation": 7, "startedAt": 0, "unlockAt": 0 } },
                "grants":     { "youtube.com": { "grantedAt": 0, "expiresAt": 0 } } },
  "statistics": { "days": { "2026-09-20": { "relevantMs": 0, "irrelevantMs": 0, "overrideMs": 0, "frictionTriggered": 0, "overrides": 0 } } },
  "sessions": [ { "domain": "pcmag.com", "title": "Best Gaming PCs…", "classification": "irrelevant", "startedAt": 0, "endedAt": 0, "overridden": true } ],
  "currentSession": null,
  "cache:classification": { "schemaVersion": 1, "entries": [["cls:v1:…", { "value": {…}, "createdAt": 0, "lastAccessedAt": 0, "expiresAt": 0 }]] },
  "cache:embedding":      { "schemaVersion": 1, "entries": [["emb:v1:bge-small-en-v1.5-int8:…", { "value": [384 numbers], … }]] },
  "cache:retrieval":      { "schemaVersion": 1, "entries": [] }
}
```

Limits: see [Caching](#caching); sessions 2000 / 14 days retention (`schema.js → DEFAULT_LIMITS`).

## Testing

```bash
npm test                 # everything (≈30 s)
npm run test:unit        # 101 tests, no model needed
npm run test:model       # real BGE model: embeddings, similarity ordering, fixture titles
npm run test:integration # boots the real background.js against a fake `browser` API
```

Coverage highlights:

* **Regex:** matching, non-matching, case-insensitivity, invalid patterns, full precedence chain,
  whole-word goal terms.
* **Similarity:** identical / orthogonal / opposite / zero vectors, argmax selection.
* **Embedding classifier:** pure threshold logic, positive/negative anchor scoring with a
  deterministic fake model, anchor caching, unavailable-model fall-through.
* **Friction manager:** countdown timing, early-Continue rejection, reload persistence,
  tab-switch reset → full timer on return, repeated switching never completes, completed
  timer survives a switch, stale generation refused, independent per-tab timers, navigation
  restart (hash-only preserved), grant expiry, domain scoping, abandonment, tab-close cleanup.
* **Caches:** deterministic/normalised keys, domain/title misses, TTL expiry, LRU eviction,
  expired-before-LRU, restart persistence, schema-version mismatch ignored, Float32 codec,
  concurrent dedupe, prefix invalidation, config-fingerprint invalidation, model-versioned
  embedding keys.
* **Session tracker:** per-class accumulation, override accounting, midnight split, bounded logs.
* **Controller:** allow / block / warn flows, failing classifier is skipped, cache, ignored URLs.
* **Layer 3:** verdict parsing, prompt content, DuckDuckGo HTML parsing, retrieval cache +
  dedupe + permission gating + failure → null, LLM manager lazy load / dedupe / unavailable,
  classifier gating (disabled, confident, no previous), `llm` vs `llm+search`, pipeline
  fallback to the embedding verdict on LLM error.
* **Integration:** goal → anchors → relevant page allowed → irrelevant page redirected →
  countdown → Continue refused early / accepted later → grant → no re-redirect → statistics →
  revoke → re-friction; tab switch mid-countdown → background tab `inactive` → return gives a
  full timer → stale generation refused; cache hit + irrelevant page still gets friction;
  caches survive a background restart and contain no URLs; layer 3 off by default; LLM
  (injected fake) decides questionable pages and is skipped for confident ones and cache hits;
  search blocked without host permission, `llm+search` with it, title-only query, second probe
  served from the retrieval cache; Go Back; user allow rule overriding the model; unsupported URLs.

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
(60 relevant / 45 irrelevant / 28 ambiguous, plus 20 generic-title rows used by the layer
ablation below). `npm run benchmark` runs the regex + embedding layers:

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

### Layer ablation (`npm run benchmark:layers`)

`scripts/benchmark-layers.mjs` runs the real `DecisionPipeline` in four configurations over the
same dataset, now 153 titles including 20 deliberately generic ones ("Processes", "Episode 42",
"Building Better Systems", …) each paired with a domain and hand-labelled. Web search is served
offline from `tests/data/search-fixtures.json`; the LLM is by default a deterministic **mock that
follows the prompt rules** (relevant only when the context shares goal terms, irrelevant on
distraction terms, otherwise questionable), so the numbers measure the *pipeline*, not a model.
Pass `--llm ollama --model qwen3:0.6b` with a local server to measure a real one.

Result in this sandbox (searchMode=ambiguous, mock LLM):

| config | 3-way acc. | generic-title acc. | block recall | block FNR | searches | LLM calls |
| --- | --- | --- | --- | --- | --- | --- |
| BGE only | 77.8% | 55.0% | 82.4% | 17.6% | 0 | 0 |
| BGE + search | 77.8% | 55.0% | 82.4% | 17.6% | 10 | 0 |
| BGE + LLM | 77.8% | 55.0% | 82.4% | 17.6% | 0 | 25 |
| BGE + search + LLM | **79.1%** | **65.0%** | **86.3%** | **13.7%** | 10 | 25 |

Block precision stayed at 100% (no relevant page newly blocked) in all four. Takeaways:
search without an LLM cannot change verdicts (nothing consumes the context); the LLM without
context correctly refuses to guess (its verdicts are downgraded to questionable because
evidence is `none`); only the combination moves generic titles, and only modestly. 25 of 153
titles (16%) reached the expensive layers. Treat this as a pipeline sanity check — the
mock is not a language model and the fixtures were written by the author.

## Known limitations

* **English only.** BGE-small-en is an English model; other languages will score poorly.
* **Title-only signal.** Pages with generic titles ("YouTube", "Home") are judged on the URL
  path; single-page apps that update titles late may be classified twice.
* **Thresholds are heuristics** tuned on a 133-title set by the author; calibrate per user.
* **Ambiguous content** skews relevant when the goal topic is mentioned (see benchmark).
  The search + LLM layers exist to fix this; `npm run benchmark:layers` measures the pipeline
  with offline search fixtures and a rule-following mock LLM (see Benchmark). Real DuckDuckGo
  HTML and real model inference could not be exercised in the development sandbox (no
  network) — the integration tests inject a fake LLM and a fake `fetch`.
* **LLM cost.** In-browser: ≈400 MB one-time download, ~1 GB RAM while loaded, seconds per
  judgment (it is unloaded after 10 min idle). DuckDuckGo's HTML markup may change; the parser
  then yields no results and the LLM simply runs without context.
* **Memory.** The resident model costs roughly 150–200 MB while loaded; it is loaded lazily
  and only when a title reaches Layer 2.
* **Friction, not DRM.** Private windows, other browsers, or disabling the add-on bypass it by
  design.
* **Event page restarts** reload the model on the next uncertain title (~0.4–1 s); the
  embedding cache is persisted to soften this.
* Developed and tested on Linux via automated tests against a faithful `browser` API stub and
  the real model; manual verification in a desktop Firefox profile is still recommended
  before wider use (see Installation).

## Using and verifying the AI layers

1. Options → **AI classification** → tick *Enable local LLM*; approve the permission Firefox
   shows (Hugging Face for the in-browser runtime, or `localhost` for Ollama / llama.cpp).
   Optionally tick *Enable semantic web search* and approve `html.duckduckgo.com`.
2. Click **Download & load LLM now** (one-time, a few minutes) — the status line shows progress.
3. Type an ambiguous title (e.g. `Building Better Systems`) in *Try a title* and press
   **Classify** for the full trace (per-stage timings, search status/query/results, LLM JSON,
   evidence quality, final source) or **Test search + LLM** to probe the two layers directly.
4. Browse normally. The popup footer shows `● Local model ready` / `● Semantic search: online`;
   `source` reads `llm` / `llm+search` for pages the LLM decided. Click **Why?** for the
   explanation and answer **Correct? Yes/No** to store local feedback (exportable as JSON from
   Options). Tick *Debug mode* to see the `TITLE / REGEX / BGE / SEARCH / LLM / FINAL / TOTAL`
   block in the popup.

To use Qwen3-0.6B today: `ollama pull qwen3:0.6b`, choose *Ollama on localhost* as runtime, and
leave endpoint/model empty (defaults to `http://localhost:11434`, `qwen3:0.6b`).

## Acknowledgements

* [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT)
* [Transformers.js](https://github.com/xenova/transformers.js) (Apache-2.0) and
  [ONNX Runtime Web](https://onnxruntime.ai/) (MIT)
* Friction UX inspired by ScreenZen.
