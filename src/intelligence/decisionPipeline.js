/**
 * The single, central classification pipeline. Everything that turns a page into a
 * classification goes through here — popup, background, friction page and benchmark all call
 * this and never re-implement any step.
 *
 *   normalise ─► regex (explicit user rules first) ─► embedding ─► [search] ─► [local LLM] ─► evidence-aware result
 *
 * Cost ordering is the design rule: regex → embedding → cached search → fresh search → LLM.
 * Later stages run only when earlier ones were not confident, and only when enabled.
 * Any stage may fail; the pipeline always returns a result with `source` telling where the
 * evidence came from. Policy (allow/warn/block) is applied by the caller, never here.
 */
import { makeResult } from '../classifier/classifier.js';
import { CLASSIFICATION, EVIDENCE_QUALITY, SEARCH_MODE, SOURCE } from '../storage/schema.js';
import { isGenericTitle } from '../search/queryBuilder.js';
import { PipelineTelemetry } from './telemetry.js';

const HOUR = 60 * 60 * 1000;

export class DecisionPipeline {
  /**
   * @param {Object} deps
   * @param {import('../classifier/classifier.js').Classifier} deps.regex
   * @param {import('../classifier/classifier.js').Classifier} [deps.embedding]
   * @param {import('../search/searchManager.js').SearchManager} [deps.search]
   * @param {import('../llm/llmClassifier.js').LlmClassifier} [deps.llm]
   * @param {PipelineTelemetry} [deps.telemetry]
   * @param {() => number} [deps.now]
   */
  constructor({ regex, embedding = null, search = null, llm = null, telemetry = new PipelineTelemetry(), now = () => performance.now() }) {
    this.regex = regex;
    this.embedding = embedding;
    this.search = search;
    this.llm = llm;
    this.telemetry = telemetry;
    this.now = now;
  }

  /**
   * @param {import('../classifier/classifier.js').ClassificationContext} context
   * @param {{ onStage?: (stage: string) => void, signal?: { stale: boolean } }} [hooks]
   *   `onStage` lets the UI show "Analyzing page…" once expensive stages start; `signal.stale`
   *   is checked between stages so a superseded request stops spending resources.
   */
  async classify(context, { onStage = () => {}, signal = null } = {}) {
    const t0 = this.now();
    const trace = [];
    const timings = {};
    const settings = context.settings ?? {};
    const finish = (result, extra = {}) => {
      timings.totalMs = round(this.now() - t0);
      this.telemetry.recordStage('total', timings.totalMs);
      this.telemetry.recordSource(result.source);
      return { ...result, ...extra, trace, timings };
    };

    // 1. Deterministic layer (explicit user policy has absolute precedence; see regexClassifier).
    const regexResult = await this.runStage('regex', this.regex, context, trace, timings);
    if (regexResult) return finish(decorate(regexResult, { sourceKind: sourceKindOf(regexResult.source), confidence: 1, evidenceQuality: EVIDENCE_QUALITY.HIGH }));
    if (signal?.stale) return finish(staleResult());

    // 2. Semantic similarity.
    let embeddingResult = null;
    if (this.embedding && settings.embeddingsEnabled !== false) {
      embeddingResult = await this.runStage('embedding', this.embedding, context, trace, timings);
      if (embeddingResult && embeddingResult.confident !== false) {
        return finish(decorate(embeddingResult, { sourceKind: SOURCE.EMBEDDING, confidence: embeddingConfidence(embeddingResult), evidenceQuality: EVIDENCE_QUALITY.MEDIUM }));
      }
    }
    if (signal?.stale) return finish(staleResult());

    // 3 + 4. Web context and local LLM — only for genuinely uncertain pages.
    const generic = isGenericTitle(context.text);
    const llmWanted = Boolean(this.llm) && settings.llmEnabled === true;
    let searchOutcome = null;
    if (llmWanted && this.shouldSearch(settings, generic, embeddingResult)) {
      onStage('searching');
      searchOutcome = await this.runSearch(context, settings, trace, timings);
      if (signal?.stale) return finish(staleResult());
    }

    if (llmWanted) {
      onStage('analyzing');
      const llmResult = await this.runStage('llm', this.llm, { ...context, previous: embeddingResult, search: searchOutcome }, trace, timings);
      if (llmResult) {
        return finish(this.applyEvidencePolicy(llmResult, { settings, generic, searchOutcome, embeddingResult }));
      }
    }

    // 5. Fallback: the tentative embedding verdict, else "unknown".
    if (embeddingResult) return finish(decorate(embeddingResult, { sourceKind: SOURCE.EMBEDDING, confidence: embeddingConfidence(embeddingResult), evidenceQuality: EVIDENCE_QUALITY.LOW, searchUsed: Boolean(searchOutcome) }));
    return finish(decorate(makeResult(CLASSIFICATION.UNKNOWN, 'fallback', 'No classifier produced a result'), { sourceKind: SOURCE.FALLBACK, confidence: 0, evidenceQuality: EVIDENCE_QUALITY.NONE }));
  }

  shouldSearch(settings, generic, embeddingResult) {
    if (!this.search || settings.searchEnabled !== true) return false;
    if (settings.searchMode === SEARCH_MODE.UNCERTAIN) return true;
    // 'ambiguous': only titles that carry too little information on their own, or when the
    // embedding layer could not run at all.
    return generic || !embeddingResult;
  }

  async runStage(name, classifier, context, trace, timings) {
    const t = this.now();
    try {
      const result = await classifier.classify(context);
      timings[`${name}Ms`] = round(this.now() - t);
      this.telemetry.recordStage(name, timings[`${name}Ms`]);
      trace.push({ stage: name, decided: Boolean(result), tentative: result?.confident === false, classification: result?.classification ?? null, score: result?.score ?? null, ms: timings[`${name}Ms`] });
      return result;
    } catch (e) {
      timings[`${name}Ms`] = round(this.now() - t);
      trace.push({ stage: name, error: String(e?.message ?? e), ms: timings[`${name}Ms`] });
      return null;
    }
  }

  async runSearch(context, settings, trace, timings) {
    const t = this.now();
    let outcome = null;
    try {
      outcome = await this.search.search(
        { title: context.text, domain: context.domain },
        { maxResults: settings.searchMaxResults, ttlMs: Number(settings.searchCacheHours) > 0 ? Number(settings.searchCacheHours) * HOUR : undefined }
      );
    } catch (e) {
      outcome = { status: 'error', query: null, results: [], evidenceQuality: EVIDENCE_QUALITY.NONE, error: String(e?.message ?? e) };
    }
    timings.searchMs = round(this.now() - t);
    this.telemetry.recordStage('search', timings.searchMs);
    this.telemetry.bump('searches');
    if (outcome.cached) this.telemetry.bump('searchCacheHits');
    trace.push({ stage: 'search', status: outcome.status, query: outcome.query, results: outcome.results.length, evidenceQuality: outcome.evidenceQuality, cached: Boolean(outcome.cached), ms: timings.searchMs, error: outcome.error });
    return outcome;
  }

  /**
   * Evidence-aware post-processing (the LLM's confidence is not ground truth):
   *  - low confidence → questionable;
   *  - a definite verdict with no usable evidence → questionable;
   *  - evidence phrases the model invented are dropped and reduce confidence.
   */
  applyEvidencePolicy(llmResult, { settings, generic, searchOutcome, embeddingResult }) {
    const searchUsed = Boolean(searchOutcome);
    // Without web context the only evidence is the title itself: worthless when generic, weak otherwise.
    const evidenceQuality = searchUsed ? searchOutcome.evidenceQuality : generic ? EVIDENCE_QUALITY.NONE : EVIDENCE_QUALITY.LOW;
    let { classification, confidence } = llmResult;
    const notes = [];
    const llm = llmResult.llm ?? {};
    if (llm.unsupportedEvidence?.length && !llm.evidence?.length) {
      confidence = Math.min(confidence, 0.5);
      notes.push('evidence not found in supplied context');
    }
    const minConfidence = Number(settings.llmMinConfidence ?? 0.6);
    if (classification !== CLASSIFICATION.QUESTIONABLE) {
      if (confidence < minConfidence) {
        classification = CLASSIFICATION.QUESTIONABLE;
        notes.push(`confidence ${confidence} below ${minConfidence}`);
      } else if (evidenceQuality === EVIDENCE_QUALITY.NONE) {
        classification = CLASSIFICATION.QUESTIONABLE;
        notes.push('no usable evidence about this page');
      }
    }
    if (notes.length) this.telemetry.bump('downgraded');
    if (llm.cached) this.telemetry.bump('llmCacheHits');
    else this.telemetry.bump('llmCalls');
    return decorate(
      { ...llmResult, classification, confidence, reason: notes.length ? `${llmResult.reason} (downgraded: ${notes.join('; ')})` : llmResult.reason },
      { sourceKind: SOURCE.LOCAL_LLM, evidenceQuality, searchUsed, searchQuery: searchOutcome?.query ?? null, searchStatus: searchOutcome?.status ?? null, webContext: searchOutcome?.results ?? [], downgraded: notes.length > 0 }
    );
  }

  getTelemetry() {
    return this.telemetry.snapshot();
  }
}

function decorate(result, extra) {
  return { semanticScore: result.score ?? null, searchUsed: false, ...result, ...extra };
}

/** Distance from the nearest threshold, scaled: 0.5 at the threshold → 1 far away. */
function embeddingConfidence(result) {
  if (typeof result.score !== 'number') return 0.5;
  const distance = Math.abs(result.score - 0.5);
  return Math.round(Math.min(1, 0.5 + distance) * 100) / 100;
}

function sourceKindOf(source) {
  return String(source).startsWith('rule:') ? SOURCE.EXPLICIT_RULE : SOURCE.REGEX;
}

function staleResult() {
  return decorate(makeResult(CLASSIFICATION.UNKNOWN, 'stale', 'Superseded by a newer request'), { sourceKind: SOURCE.FALLBACK, confidence: 0, evidenceQuality: EVIDENCE_QUALITY.NONE, stale: true });
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}
