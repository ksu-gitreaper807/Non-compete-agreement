/**
 * Policy engine: maps a classification to an enforcement decision and friction parameters.
 * Classification never knows about enforcement; enforcement never recomputes classification.
 */
import { CLASSIFICATION, DECISION, DEFAULT_SETTINGS } from '../storage/schema.js';

const VALID_DECISIONS = new Set(Object.values(DECISION));

/**
 * @returns {{ decision: string, frictionSeconds: number, overrideMinutes: number }}
 */
export function decide(classification, settings = DEFAULT_SETTINGS) {
  const policy = { ...DEFAULT_SETTINGS.policy, ...(settings.policy ?? {}) };
  let decision = policy[classification] ?? DECISION.ALLOW;
  if (!VALID_DECISIONS.has(decision)) decision = DECISION.ALLOW;

  if (settings.enabled === false) decision = DECISION.ALLOW;

  return {
    decision,
    frictionSeconds: frictionFor(decision, classification, settings),
    overrideMinutes: Number(settings.overrideMinutes ?? DEFAULT_SETTINGS.overrideMinutes),
  };
}

function frictionFor(decision, classification, settings) {
  if (decision === DECISION.ALLOW) return 0;
  const normal = Number(settings.frictionSeconds ?? DEFAULT_SETTINGS.frictionSeconds);
  if (decision === DECISION.BLOCK) return normal;
  // WARN: configurable friction for questionable pages
  const mode = settings.questionableFrictionMode ?? DEFAULT_SETTINGS.questionableFrictionMode;
  if (mode === 'none') return 0;
  if (mode === 'short') return Number(settings.questionableFrictionSeconds ?? DEFAULT_SETTINGS.questionableFrictionSeconds);
  return normal;
}

/** Whether a decision requires the friction page at all. */
export function requiresFriction(decisionInfo) {
  return decisionInfo.decision !== DECISION.ALLOW && decisionInfo.frictionSeconds > 0;
}

export function isBlockingDecision(decision) {
  return decision === DECISION.BLOCK || decision === DECISION.WARN;
}

export { CLASSIFICATION, DECISION };
