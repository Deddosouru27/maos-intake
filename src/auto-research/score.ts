export interface ScoredItem {
  knowledge_type: string;
  content: string;
  immediate_relevance: number;
  tags: string[];
  entity_objects?: { name: string; type: string }[];
  business_value?: string | null;
}

export interface QualityBreakdown {
  type_diversity: number;
  entity_coverage: number;
  tag_quality: number;
  score_distribution: number;
  content_quality: number;
  completeness: number;
}

export interface QualityResult {
  score: number;
  breakdown: QualityBreakdown;
  items_count: number;
}

const WEIGHTS = {
  type_diversity: 0.15,
  entity_coverage: 0.20,
  tag_quality: 0.15,
  score_distribution: 0.25,
  content_quality: 0.15,
  completeness: 0.10,
};

export function computeQualityScore(items: ScoredItem[]): QualityResult {
  const zero: QualityBreakdown = { type_diversity: 0, entity_coverage: 0, tag_quality: 0, score_distribution: 0, content_quality: 0, completeness: 0 };
  if (items.length === 0) return { score: 0, breakdown: zero, items_count: 0 };

  // 1. Type diversity — 3+ distinct knowledge types = 1.0
  const types = new Set(items.map((i) => i.knowledge_type));
  const type_diversity = Math.min(types.size / 3, 1);

  // 2. Entity coverage — fraction of items with at least 1 named entity
  const entity_coverage = items.filter((i) => (i.entity_objects?.length ?? 0) > 0).length / items.length;

  // 3. Tag quality — avg tags per item (2-4 is ideal)
  const avgTags = items.reduce((sum, i) => sum + i.tags.length, 0) / items.length;
  const tag_quality = avgTags === 0 ? 0 : avgTags < 2 ? 0.5 : avgTags <= 4 ? 1.0 : 0.7;

  // 4. Score distribution — penalize inflation (mean > 0.6) and uniformity (stddev < 0.05)
  const scores = items.map((i) => i.immediate_relevance);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const inflation_penalty = mean > 0.6 ? (mean - 0.6) * 2 : 0;
  const variance_penalty = stddev < 0.05 ? 0.5 : 0;
  const score_distribution = Math.max(0, Math.min(1, 1 - inflation_penalty - variance_penalty));

  // 5. Content quality — 100-300 chars is ideal
  const content_quality =
    items.reduce((sum, item) => {
      const len = item.content.length;
      return sum + (len < 50 ? 0 : len <= 300 ? 1.0 : 0.8);
    }, 0) / items.length;

  // 6. Completeness — fraction with non-empty business_value
  const completeness = items.filter((i) => i.business_value && i.business_value.length > 5).length / items.length;

  const breakdown: QualityBreakdown = { type_diversity, entity_coverage, tag_quality, score_distribution, content_quality, completeness };

  const score = parseFloat(
    (
      type_diversity * WEIGHTS.type_diversity +
      entity_coverage * WEIGHTS.entity_coverage +
      tag_quality * WEIGHTS.tag_quality +
      score_distribution * WEIGHTS.score_distribution +
      content_quality * WEIGHTS.content_quality +
      completeness * WEIGHTS.completeness
    ).toFixed(4),
  );

  return { score, breakdown, items_count: items.length };
}
