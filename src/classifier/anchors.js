/**
 * Generates positive/negative semantic anchors from a natural-language goal using simple
 * local logic. A future local LLM can replace `generateAnchors` behind the same signature.
 */
import { splitGoalPhrases } from '../utils/text.js';
import { DEFAULT_NEGATIVE_ANCHORS } from '../storage/schema.js';

/** Small topic expansion table. Keys are matched as substrings of goal phrases. */
const TOPIC_EXPANSIONS = {
  'operating system': ['process management', 'virtual memory', 'file systems', 'linux kernel', 'concurrency and scheduling', 'systems programming'],
  'os ': ['operating systems', 'linux kernel', 'virtual memory'],
  'c++': ['c++ programming', 'stl and templates', 'memory management in c++', 'systems programming'],
  'c programming': ['pointers and memory', 'systems programming', 'compilers'],
  'rust': ['rust programming', 'ownership and borrowing', 'systems programming'],
  'python': ['python programming', 'python tutorial', 'software development'],
  'javascript': ['javascript programming', 'web development', 'frontend frameworks'],
  'web dev': ['html css javascript', 'web development', 'frontend frameworks'],
  'algorithm': ['data structures', 'algorithm analysis', 'competitive programming', 'leetcode problems'],
  'data structure': ['algorithms', 'binary trees and graphs', 'complexity analysis'],
  'machine learning': ['neural networks', 'deep learning', 'training models', 'pytorch tutorial', 'statistics and probability'],
  'deep learning': ['neural networks', 'transformers and attention', 'pytorch', 'gradient descent'],
  'math': ['calculus', 'linear algebra', 'mathematical proofs', 'probability and statistics'],
  'calculus': ['derivatives and integrals', 'limits and series', 'multivariable calculus'],
  'linear algebra': ['matrices and vectors', 'eigenvalues', 'vector spaces'],
  'statistic': ['probability theory', 'hypothesis testing', 'regression analysis'],
  'physics': ['classical mechanics', 'electromagnetism', 'quantum mechanics', 'physics lecture'],
  'chemistry': ['organic chemistry', 'chemical reactions', 'chemistry lecture'],
  'biology': ['cell biology', 'genetics', 'biology lecture'],
  'fitness': ['workout routine', 'strength training', 'running and cardio', 'nutrition and diet', 'exercise form'],
  'workout': ['strength training', 'exercise routine', 'gym program'],
  'running': ['running training plan', 'marathon preparation', 'cardio workout'],
  'reading': ['book summary', 'literature analysis', 'classic novels', 'non-fiction books'],
  'book': ['book review', 'literature', 'reading list'],
  'writing': ['writing craft', 'essay structure', 'editing and grammar'],
  'thesis': ['academic research', 'research papers', 'scientific writing', 'literature review'],
  'research': ['academic papers', 'scientific literature', 'research methodology'],
  'language': ['vocabulary practice', 'grammar lessons', 'language learning'],
  'spanish': ['spanish grammar', 'spanish vocabulary', 'learn spanish'],
  'japanese': ['japanese grammar', 'kanji practice', 'learn japanese'],
  'french': ['french grammar', 'french vocabulary', 'learn french'],
  'german': ['german grammar', 'german vocabulary', 'learn german'],
  'design': ['user interface design', 'design systems', 'typography and layout'],
  'music': ['music theory', 'instrument practice', 'music lessons'],
  'guitar': ['guitar lessons', 'guitar chords', 'music theory'],
  'piano': ['piano lessons', 'sheet music', 'music theory'],
  'interview': ['coding interview preparation', 'system design interview', 'leetcode problems'],
  'exam': ['exam preparation', 'practice questions', 'study notes'],
  'history': ['history lecture', 'historical events', 'history documentary'],
  'economics': ['microeconomics', 'macroeconomics', 'economics lecture'],
  'finance': ['personal finance', 'investing basics', 'financial statements'],
  'network': ['computer networking', 'tcp ip', 'network protocols'],
  'database': ['sql queries', 'database design', 'database systems'],
  'security': ['cybersecurity', 'cryptography', 'security vulnerabilities'],
  'compiler': ['compiler design', 'parsing and lexing', 'programming languages'],
  'distributed': ['distributed systems', 'consensus algorithms', 'fault tolerance'],
  'cloud': ['cloud computing', 'kubernetes', 'aws tutorial'],
  'devops': ['ci cd pipelines', 'docker and kubernetes', 'infrastructure as code'],
  'course': ['lecture notes', 'course materials', 'homework assignments'],
  'coursework': ['homework assignments', 'lecture notes', 'course project'],
  'project': ['project documentation', 'software engineering', 'github repository'],
};

/**
 * @param {string} goal
 * @param {{ existingNegative?: string[] }} options
 * @returns {{ positive: string[], negative: string[] }}
 */
export function generateAnchors(goal, options = {}) {
  const phrases = splitGoalPhrases(goal);
  const positive = new Set();
  for (const phrase of phrases) {
    positive.add(phrase.toLowerCase());
    const lowered = ` ${phrase.toLowerCase()} `;
    for (const [key, expansions] of Object.entries(TOPIC_EXPANSIONS)) {
      if (lowered.includes(key)) expansions.forEach((e) => positive.add(e));
    }
  }
  if (goal && goal.trim()) positive.add(goal.trim().toLowerCase());
  const negative = options.existingNegative?.length ? options.existingNegative : [...DEFAULT_NEGATIVE_ANCHORS];
  return { positive: [...positive].slice(0, 30), negative: [...negative].slice(0, 30) };
}

/** Interface for a future LLM-backed generator. */
export class AnchorGenerator {
  async generate(goal, options) {
    return generateAnchors(goal, options);
  }
}
