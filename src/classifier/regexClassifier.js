/**
 * Layer 1: deterministic rules. Cheap, runs for every page.
 *
 * Precedence (first match wins):
 *   1. explicit user block  (blocked domains, block regexes)
 *   2. explicit user allow  (allowed domains, allow regexes)
 *   3. automatic block      (built-in patterns for unmistakable distractions)
 *   4. automatic allow      (built-in patterns for goal terms derived from the goal text)
 *   5. no decision          -> semantic classifier
 *
 * Regexes are matched case-insensitively against "<title> <url>".
 */
import { Classifier, makeResult } from './classifier.js';
import { compilePatterns, firstMatch } from '../utils/regex.js';
import { domainMatches, normalizeForMatching, splitGoalPhrases } from '../utils/text.js';
import { CLASSIFICATION } from '../storage/schema.js';

/** Conservative built-in block list; only obviously off-goal hosts. Users can override via allow rules. */
export const AUTO_BLOCK_PATTERNS = Object.freeze([
  '\\bnetflix\\.com\\b',
  '\\bhulu\\.com\\b',
  '\\bdisneyplus\\.com\\b',
  '\\btwitch\\.tv\\b',
  '\\btiktok\\.com\\b',
  '\\b9gag\\.com\\b',
  '\\bstore\\.steampowered\\.com\\b',
]);

export class RegexClassifier extends Classifier {
  constructor({ autoBlockPatterns = AUTO_BLOCK_PATTERNS } = {}) {
    super();
    this.autoBlock = compilePatterns(autoBlockPatterns).compiled;
    this.cache = { key: null, allow: [], block: [], goalTerms: [] };
  }

  get name() {
    return 'regex';
  }

  /** Compile user rules once per rule-set change. */
  prepare(rules, goal) {
    const key = JSON.stringify([rules?.allow ?? [], rules?.block ?? [], goal ?? '']);
    if (key === this.cache.key) return this.cache;
    const allow = compilePatterns(rules?.allow ?? []);
    const block = compilePatterns(rules?.block ?? []);
    const goalTerms = compilePatterns(goalTermPatterns(goal));
    this.cache = { key, allow: allow.compiled, block: block.compiled, goalTerms: goalTerms.compiled, invalid: [...allow.invalid, ...block.invalid] };
    return this.cache;
  }

  async classify(context) {
    const { domain, title, url, settings, rules, goal } = context;
    const compiled = this.prepare(rules, goal);
    const haystack = normalizeForMatching(`${title ?? ''} ${url ?? ''}`);

    // 1. explicit user block
    const blockedDomain = (settings?.blockedDomains ?? []).find((d) => domainMatches(domain, d));
    if (blockedDomain) return makeResult(CLASSIFICATION.IRRELEVANT, 'rule:block-domain', `Domain "${blockedDomain}" is on your block list`);
    const blockPattern = firstMatch(compiled.block, haystack);
    if (blockPattern) return makeResult(CLASSIFICATION.IRRELEVANT, 'rule:block', `Matched block rule /${blockPattern}/`);

    // 2. explicit user allow
    const allowedDomain = (settings?.allowedDomains ?? []).find((d) => domainMatches(domain, d));
    if (allowedDomain) return makeResult(CLASSIFICATION.RELEVANT, 'rule:allow-domain', `Domain "${allowedDomain}" is on your allow list`);
    const allowPattern = firstMatch(compiled.allow, haystack);
    if (allowPattern) return makeResult(CLASSIFICATION.RELEVANT, 'rule:allow', `Matched allow rule /${allowPattern}/`);

    // 3. automatic block
    const autoBlock = firstMatch(this.autoBlock, haystack);
    if (autoBlock) return makeResult(CLASSIFICATION.IRRELEVANT, 'auto:block', `Built-in distraction pattern /${autoBlock}/`);

    // 4. automatic allow: literal goal phrases in the title
    const goalTerm = firstMatch(compiled.goalTerms, normalizeForMatching(title));
    if (goalTerm) return makeResult(CLASSIFICATION.RELEVANT, 'auto:allow', `Title contains goal term /${goalTerm}/`);

    return null;
  }
}

/** Escape a literal phrase into a whole-word regex. Only phrases of >= 4 chars qualify. */
export function goalTermPatterns(goal) {
  return splitGoalPhrases(goal)
    .filter((p) => p.length >= 4)
    .map((p) => `(?<![\\p{L}\\p{N}])${escapeRegex(p.toLowerCase())}(?![\\p{L}\\p{N}])`);
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
