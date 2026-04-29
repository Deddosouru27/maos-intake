/**
 * Per-item quality scoring for extracted_knowledge rows.
 * Extends the batch quality concept from auto-research/score.ts to single-item granularity.
 *
 * Dimensions (each 0 or 1, weighted → quality_score 0..1):
 *   has_entities       0.25 — graph population depends on named entities
 *   tag_score          0.20 — 2+ tags = full; 1 = half; 0 = zero
 *   content_score      0.25 — 50-300 chars = full; <50 = zero; >300 = 0.8
 *   has_business_value 0.15 — actionability signal
 *   score_calibrated   0.15 — immediate_relevance ≠ 0.5 (default = calibration not applied)
 */

export interface ItemQualityInput {
  content: string;
  tags?: string[] | null;
  entity_objects?: { name: string; type: string }[] | null;
  business_value?: string | null;
  immediate_relevance?: number | null;
}

export interface ItemQualityResult {
  has_entities: boolean;
  tag_count: number;
  content_length: number;
  has_business_value: boolean;
  score_in_normal_range: boolean;
  completeness_score: number;
  quality_score: number;
}

const WEIGHTS = {
  entity: 0.25,
  tag: 0.20,
  content: 0.25,
  business_value: 0.15,
  calibration: 0.15,
};

export function computeItemQuality(item: ItemQualityInput): ItemQualityResult {
  const has_entities = (item.entity_objects?.length ?? 0) > 0;
  const tag_count = item.tags?.length ?? 0;
  const content_length = item.content?.length ?? 0;
  const has_business_value = !!(item.business_value && item.business_value.trim().length > 5);
  const relevance = item.immediate_relevance ?? 0.5;
  const score_in_normal_range = relevance !== 0.5;

  const entity_score = has_entities ? 1 : 0;
  const tag_score = tag_count === 0 ? 0 : tag_count < 2 ? 0.5 : 1.0;
  const content_score = content_length < 50 ? 0 : content_length <= 300 ? 1.0 : 0.8;
  const bv_score = has_business_value ? 1 : 0;
  const calibration_score = score_in_normal_range ? 1 : 0;

  const completeness_score = parseFloat(
    (
      entity_score * WEIGHTS.entity +
      tag_score * WEIGHTS.tag +
      content_score * WEIGHTS.content +
      bv_score * WEIGHTS.business_value +
      calibration_score * WEIGHTS.calibration
    ).toFixed(4),
  );

  return {
    has_entities,
    tag_count,
    content_length,
    has_business_value,
    score_in_normal_range,
    completeness_score,
    quality_score: completeness_score,
  };
}
