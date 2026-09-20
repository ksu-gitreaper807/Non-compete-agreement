/**
 * Safe regular-expression compilation. Invalid patterns never throw; they are reported instead.
 */

const MAX_PATTERN_LENGTH = 500;

export function validatePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return { valid: false, error: 'Pattern is empty' };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern longer than ${MAX_PATTERN_LENGTH} characters` };
  }
  try {
    new RegExp(pattern, 'iu');
    return { valid: true, error: null };
  } catch (e) {
    try {
      // Some patterns (e.g. "\-") are valid without the unicode flag.
      new RegExp(pattern, 'i');
      return { valid: true, error: null };
    } catch {
      return { valid: false, error: e.message };
    }
  }
}

/**
 * Compile a list of pattern strings. Returns compiled regexes and a list of rejected patterns.
 */
export function compilePatterns(patterns) {
  const compiled = [];
  const invalid = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    const check = validatePattern(pattern);
    if (!check.valid) {
      invalid.push({ pattern, error: check.error });
      continue;
    }
    let re;
    try {
      re = new RegExp(pattern, 'iu');
    } catch {
      re = new RegExp(pattern, 'i');
    }
    compiled.push({ pattern, regex: re });
  }
  return { compiled, invalid };
}

/** Test text against compiled patterns; returns the first matching pattern string or null. */
export function firstMatch(compiled, text) {
  if (!text) return null;
  for (const { pattern, regex } of compiled) {
    regex.lastIndex = 0;
    if (regex.test(text)) return pattern;
  }
  return null;
}
