/**
 * Local-only latency/counter telemetry for the decision pipeline. Nothing here is ever
 * transmitted; it is shown in the Options debug panel and used to tune the pipeline.
 */
const RESERVOIR = 200;

export class LatencyStat {
  constructor() {
    this.count = 0;
    this.total = 0;
    this.max = 0;
    this.recent = [];
  }

  add(ms) {
    if (!Number.isFinite(ms)) return;
    this.count++;
    this.total += ms;
    this.max = Math.max(this.max, ms);
    this.recent.push(ms);
    if (this.recent.length > RESERVOIR) this.recent.shift();
  }

  summary() {
    const sorted = [...this.recent].sort((a, b) => a - b);
    const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null);
    return { count: this.count, meanMs: this.count ? Math.round(this.total / this.count) : null, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: Math.round(this.max) };
  }
}

export class PipelineTelemetry {
  constructor() {
    this.stages = { regex: new LatencyStat(), embedding: new LatencyStat(), search: new LatencyStat(), llm: new LatencyStat(), total: new LatencyStat() };
    this.counters = { classifications: 0, cacheHits: 0, searches: 0, searchCacheHits: 0, llmCalls: 0, llmCacheHits: 0, downgraded: 0, stale: 0 };
    this.bySource = {};
  }

  recordStage(stage, ms) {
    this.stages[stage]?.add(ms);
  }

  bump(counter, n = 1) {
    this.counters[counter] = (this.counters[counter] ?? 0) + n;
  }

  recordSource(source) {
    this.bySource[source] = (this.bySource[source] ?? 0) + 1;
  }

  snapshot() {
    const total = this.counters.classifications + this.counters.cacheHits;
    return {
      stages: Object.fromEntries(Object.entries(this.stages).map(([k, v]) => [k, v.summary()])),
      counters: { ...this.counters, cacheHitRate: total ? Math.round((this.counters.cacheHits / total) * 100) / 100 : null },
      bySource: { ...this.bySource },
    };
  }
}
