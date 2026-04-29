import { KnowledgeItem } from '../types';

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Remove near-duplicate knowledge items extracted from the same source.
 * When two items exceed the Jaccard threshold, keep the one with higher
 * immediate_relevance (or longer content on ties).
 */
export function dedupItems(
  items: KnowledgeItem[],
  threshold = 0.7,
): { items: KnowledgeItem[]; removed: number } {
  const kept: KnowledgeItem[] = [];
  let removed = 0;

  for (const candidate of items) {
    const similarIdx = kept.findIndex(
      (k) => jaccardSimilarity(k.content, candidate.content) >= threshold,
    );
    if (similarIdx === -1) {
      kept.push(candidate);
    } else {
      const existing = kept[similarIdx];
      const keepCandidate =
        candidate.immediate_relevance > existing.immediate_relevance ||
        (candidate.immediate_relevance === existing.immediate_relevance &&
          candidate.content.length > existing.content.length);
      if (keepCandidate) {
        kept[similarIdx] = candidate;
      }
      removed++;
    }
  }

  return { items: kept, removed };
}
