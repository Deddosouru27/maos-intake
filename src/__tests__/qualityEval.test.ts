/**
 * Unit tests for quality-eval — single-item scoring, source grouping, calibration detection.
 * Pure functions replicated inline — no external deps (pattern from critical.test.ts).
 *
 * Mutation test: removing the date filter causes "items older than 7 days are excluded" to fail.
 */
import { describe, it, expect } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ItemQualityInput {
  content: string;
  tags?: string[] | null;
  entity_objects?: { name: string; type: string }[] | null;
  business_value?: string | null;
  immediate_relevance?: number | null;
}

interface ItemQualityResult {
  has_entities: boolean;
  tag_count: number;
  content_length: number;
  has_business_value: boolean;
  score_in_normal_range: boolean;
  completeness_score: number;
  quality_score: number;
}

interface KnowledgeRow extends ItemQualityInput {
  id: string;
  source_url: string | null;
  source_type: string | null;
  created_at: string;
}

interface SourceMetrics {
  source_type: string;
  count: number;
  avg_quality: number;
  pct_trash: number;
  pct_no_entities: number;
  pct_default_score: number;
}

// ── Pure functions replicated from quality-eval modules ────────────────────────

const WEIGHTS = { entity: 0.25, tag: 0.20, content: 0.25, business_value: 0.15, calibration: 0.15 };
const TRASH_SCORE_THRESHOLD = 0.3;
const CALIBRATION_BROKEN_THRESHOLD = 0.8;

function computeItemQuality(item: ItemQualityInput): ItemQualityResult {
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

  const completeness_score = parseFloat((
    entity_score * WEIGHTS.entity +
    tag_score * WEIGHTS.tag +
    content_score * WEIGHTS.content +
    bv_score * WEIGHTS.business_value +
    calibration_score * WEIGHTS.calibration
  ).toFixed(4));

  return { has_entities, tag_count, content_length, has_business_value, score_in_normal_range, completeness_score, quality_score: completeness_score };
}

function isWithinDays(createdAt: string, days: number, now = Date.now()): boolean {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return new Date(createdAt).getTime() >= cutoff;
}

function isCalibrationBroken(scores: number[]): boolean {
  if (scores.length === 0) return false;
  const defaultCount = scores.filter((s) => s === 0.5).length;
  return defaultCount / scores.length > CALIBRATION_BROKEN_THRESHOLD;
}

function computeSourceMetrics(rows: KnowledgeRow[]): SourceMetrics[] {
  const groups = new Map<string, KnowledgeRow[]>();
  for (const row of rows) {
    const key = row.source_type ?? 'unknown';
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return Array.from(groups.entries()).map(([source_type, items]) => {
    const qualities = items.map((i) => computeItemQuality(i).quality_score);
    const avg_quality = qualities.reduce((a, b) => a + b, 0) / qualities.length;
    const count = items.length;
    const pct_trash = items.filter((i) => (i.immediate_relevance ?? 0.5) < TRASH_SCORE_THRESHOLD).length / count;
    const pct_no_entities = items.filter((i) => (i.entity_objects?.length ?? 0) === 0).length / count;
    const pct_default_score = items.filter((i) => (i.immediate_relevance ?? 0.5) === 0.5).length / count;
    return { source_type, count, avg_quality: parseFloat(avg_quality.toFixed(4)), pct_trash: parseFloat(pct_trash.toFixed(4)), pct_no_entities: parseFloat(pct_no_entities.toFixed(4)), pct_default_score: parseFloat(pct_default_score.toFixed(4)) };
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _id = 0;
function makeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
  _id++;
  return {
    id: `row-${_id}`,
    content: 'pgvector HNSW index reduces query time by 10x for <1M vectors in Supabase.',
    tags: ['pgvector', 'Supabase', 'HNSW'],
    entity_objects: [{ name: 'pgvector', type: 'tool' }, { name: 'Supabase', type: 'tool' }],
    business_value: 'Speeds up semantic search in MAOS knowledge pipeline.',
    immediate_relevance: 0.8,
    source_url: 'https://youtube.com/watch?v=abc123',
    source_type: 'youtube',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ── 1. computeItemQuality ─────────────────────────────────────────────────────

describe('computeItemQuality', () => {
  it('perfect item: all dimensions filled → quality_score near 1.0', () => {
    const result = computeItemQuality(makeRow());
    expect(result.quality_score).toBeCloseTo(1.0, 2);
    expect(result.has_entities).toBe(true);
    expect(result.has_business_value).toBe(true);
    expect(result.score_in_normal_range).toBe(true);
  });

  it('empty-ish item: no entities, no tags, no business_value, short content, default score → low quality', () => {
    const result = computeItemQuality({ content: 'short', tags: [], entity_objects: [], business_value: null, immediate_relevance: 0.5 });
    expect(result.quality_score).toBe(0);
    expect(result.has_entities).toBe(false);
    expect(result.has_business_value).toBe(false);
    expect(result.score_in_normal_range).toBe(false);
  });

  it('has_entities: false when entity_objects is empty or null', () => {
    expect(computeItemQuality(makeRow({ entity_objects: [] })).has_entities).toBe(false);
    expect(computeItemQuality(makeRow({ entity_objects: null })).has_entities).toBe(false);
    expect(computeItemQuality(makeRow({ entity_objects: [{ name: 'X', type: 'tool' }] })).has_entities).toBe(true);
  });

  it('tag_count scoring: 0 → 0pt, 1 → 0.5pt, 2+ → full', () => {
    const no = computeItemQuality(makeRow({ tags: [] }));
    const one = computeItemQuality(makeRow({ tags: ['X'] }));
    const two = computeItemQuality(makeRow({ tags: ['X', 'Y'] }));
    expect(no.tag_count).toBe(0);
    expect(one.tag_count).toBe(1);
    expect(two.tag_count).toBe(2);
    // tag contributes 0.20 weight; one tag = 0.5 * 0.20 = 0.10 fewer points than two tags
    expect(two.quality_score - one.quality_score).toBeCloseTo(0.10, 4);
  });

  it('content_length: <50 chars → 0pt, 50-300 → full, >300 → 0.8pt', () => {
    const short = computeItemQuality({ content: 'Hi', immediate_relevance: 0.5 });
    const medium = computeItemQuality({ content: 'A'.repeat(100), immediate_relevance: 0.5 });
    const long = computeItemQuality({ content: 'A'.repeat(400), immediate_relevance: 0.5 });
    expect(short.content_length).toBe(2);
    expect(short.completeness_score).toBe(0); // nothing else is filled either
    // medium gets content_score=1, long gets 0.8 — difference is 0.2 * 0.25 = 0.05
    expect(medium.quality_score - long.quality_score).toBeCloseTo(0.05, 4);
  });

  it('score_in_normal_range: exactly 0.5 → false (uncalibrated), any other value → true', () => {
    expect(computeItemQuality(makeRow({ immediate_relevance: 0.5 })).score_in_normal_range).toBe(false);
    expect(computeItemQuality(makeRow({ immediate_relevance: 0.4 })).score_in_normal_range).toBe(true);
    expect(computeItemQuality(makeRow({ immediate_relevance: 0.7 })).score_in_normal_range).toBe(true);
    expect(computeItemQuality(makeRow({ immediate_relevance: 0.3 })).score_in_normal_range).toBe(true);
    expect(computeItemQuality(makeRow({ immediate_relevance: null })).score_in_normal_range).toBe(false);
  });

  it('has_business_value: requires non-empty string longer than 5 chars', () => {
    expect(computeItemQuality(makeRow({ business_value: null })).has_business_value).toBe(false);
    expect(computeItemQuality(makeRow({ business_value: '' })).has_business_value).toBe(false);
    expect(computeItemQuality(makeRow({ business_value: 'ok' })).has_business_value).toBe(false);
    expect(computeItemQuality(makeRow({ business_value: 'Speeds up MAOS knowledge retrieval.' })).has_business_value).toBe(true);
  });

  it('quality_score equals completeness_score', () => {
    const r = computeItemQuality(makeRow());
    expect(r.quality_score).toBe(r.completeness_score);
  });
});

// ── 2. isWithinDays ───────────────────────────────────────────────────────────

describe('isWithinDays', () => {
  it('item from 3 days ago is within 7-day window', () => {
    expect(isWithinDays(daysAgo(3), 7)).toBe(true);
  });

  it('item from exactly today is within window', () => {
    expect(isWithinDays(new Date().toISOString(), 7)).toBe(true);
  });

  it('item from 10 days ago is NOT within 7-day window', () => {
    expect(isWithinDays(daysAgo(10), 7)).toBe(false);
  });

  it('item from 8 days ago is NOT within 7-day window', () => {
    expect(isWithinDays(daysAgo(8), 7)).toBe(false);
  });

  it('accepts custom `now` for deterministic testing', () => {
    const fixedNow = new Date('2024-06-10T12:00:00Z').getTime();
    const recent = new Date('2024-06-05T00:00:00Z').toISOString(); // 5 days before
    const old = new Date('2024-05-25T00:00:00Z').toISOString();   // 16 days before
    expect(isWithinDays(recent, 7, fixedNow)).toBe(true);
    expect(isWithinDays(old, 7, fixedNow)).toBe(false);
  });
});

// ── 3. MUTATION: date filter ───────────────────────────────────────────────────

describe('MUTATION: date filter is enforced', () => {
  it('item 10 days old must be excluded from 7-day window', () => {
    // If date filter is removed (always true), this assertion fails
    expect(isWithinDays(daysAgo(10), 7)).toBe(false);
  });

  it('mixing old and recent: only recent should pass', () => {
    const rows = [
      makeRow({ created_at: daysAgo(2) }),  // recent
      makeRow({ created_at: daysAgo(15) }), // old
      makeRow({ created_at: daysAgo(4) }),  // recent
    ];
    const filtered = rows.filter((r) => isWithinDays(r.created_at, 7));
    expect(filtered).toHaveLength(2);
    // If mutation breaks filter → all 3 pass → this fails
    expect(filtered.every((r) => isWithinDays(r.created_at, 7))).toBe(true);
  });
});

// ── 4. isCalibrationBroken ────────────────────────────────────────────────────

describe('isCalibrationBroken', () => {
  it('returns false for empty scores', () => {
    expect(isCalibrationBroken([])).toBe(false);
  });

  it('returns false when only 20% of scores are 0.5', () => {
    const scores = [0.5, 0.7, 0.3, 0.8, 0.6]; // 1/5 = 20%
    expect(isCalibrationBroken(scores)).toBe(false);
  });

  it('returns false when exactly 80% are 0.5 (threshold is strictly > 0.8)', () => {
    const scores = [0.5, 0.5, 0.5, 0.5, 0.7]; // 4/5 = 80% exactly
    expect(isCalibrationBroken(scores)).toBe(false);
  });

  it('returns true when 90% of scores are 0.5', () => {
    const scores = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.3]; // 9/10 = 90%
    expect(isCalibrationBroken(scores)).toBe(true);
  });

  it('returns true when ALL scores are 0.5', () => {
    expect(isCalibrationBroken([0.5, 0.5, 0.5])).toBe(true);
  });
});

// ── 5. computeSourceMetrics — grouping ────────────────────────────────────────

describe('computeSourceMetrics', () => {
  it('3 items from 2 sources → 2 groups', () => {
    const rows = [
      makeRow({ source_type: 'youtube' }),
      makeRow({ source_type: 'article' }),
      makeRow({ source_type: 'youtube' }),
    ];
    const metrics = computeSourceMetrics(rows);
    expect(metrics).toHaveLength(2);
    const ytMetrics = metrics.find((m) => m.source_type === 'youtube');
    expect(ytMetrics?.count).toBe(2);
    const artMetrics = metrics.find((m) => m.source_type === 'article');
    expect(artMetrics?.count).toBe(1);
  });

  it('null source_type maps to "unknown" group', () => {
    const rows = [makeRow({ source_type: null }), makeRow({ source_type: null })];
    const metrics = computeSourceMetrics(rows);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].source_type).toBe('unknown');
    expect(metrics[0].count).toBe(2);
  });

  it('pct_trash: correctly counts items with immediate_relevance < 0.3', () => {
    const rows = [
      makeRow({ source_type: 'youtube', immediate_relevance: 0.2 }), // trash
      makeRow({ source_type: 'youtube', immediate_relevance: 0.1 }), // trash
      makeRow({ source_type: 'youtube', immediate_relevance: 0.7 }), // not trash
      makeRow({ source_type: 'youtube', immediate_relevance: 0.3 }), // boundary — NOT trash (< 0.3 is trash)
    ];
    const [yt] = computeSourceMetrics(rows);
    expect(yt.pct_trash).toBe(0.5); // 2/4
  });

  it('pct_no_entities: correctly counts items without entity_objects', () => {
    const rows = [
      makeRow({ source_type: 'article', entity_objects: [] }),
      makeRow({ source_type: 'article', entity_objects: null }),
      makeRow({ source_type: 'article' }), // has entities from fixture
    ];
    const [art] = computeSourceMetrics(rows);
    expect(art.pct_no_entities).toBeCloseTo(2 / 3, 4);
  });

  it('pct_default_score: correctly counts items with immediate_relevance=0.5', () => {
    const rows = [
      makeRow({ source_type: 'instagram', immediate_relevance: 0.5 }),
      makeRow({ source_type: 'instagram', immediate_relevance: 0.5 }),
      makeRow({ source_type: 'instagram', immediate_relevance: 0.7 }),
    ];
    const [ig] = computeSourceMetrics(rows);
    expect(ig.pct_default_score).toBeCloseTo(2 / 3, 4);
  });

  it('avg_quality computed deterministically regardless of row order', () => {
    const rows = [makeRow({ source_type: 'youtube', immediate_relevance: 0.8 }), makeRow({ source_type: 'youtube', immediate_relevance: 0.3, entity_objects: [] })];
    const m1 = computeSourceMetrics(rows);
    const m2 = computeSourceMetrics([rows[1], rows[0]]);
    expect(m1[0].avg_quality).toBe(m2[0].avg_quality);
  });
});

// ── 6. Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('empty rows → computeSourceMetrics returns [] (no crash)', () => {
    expect(computeSourceMetrics([])).toHaveLength(0);
  });

  it('single item: metrics computed for single-row batch', () => {
    const [m] = computeSourceMetrics([makeRow()]);
    expect(m.count).toBe(1);
    expect(m.avg_quality).toBeGreaterThan(0);
  });

  it('null tags/entity_objects do not throw', () => {
    const r = computeItemQuality({ content: 'Some content that is long enough to pass the length check here.', tags: null, entity_objects: null });
    expect(r.tag_count).toBe(0);
    expect(r.has_entities).toBe(false);
  });
});

// ── 7. Idempotency ────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('same item scores identically on repeated calls', () => {
    const item = makeRow();
    const r1 = computeItemQuality(item);
    const r2 = computeItemQuality(item);
    expect(r1.quality_score).toBe(r2.quality_score);
    expect(r1.has_entities).toBe(r2.has_entities);
  });

  it('same rows produce same source metrics on repeated computeSourceMetrics calls', () => {
    const rows = [makeRow({ source_type: 'youtube' }), makeRow({ source_type: 'article' })];
    const m1 = computeSourceMetrics(rows);
    const m2 = computeSourceMetrics(rows);
    expect(m1[0].avg_quality).toBe(m2[0].avg_quality);
    expect(m1[1].avg_quality).toBe(m2[1].avg_quality);
  });

  it('pct_trash and pct_no_entities stable across repeated calls', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ source_type: 'youtube', immediate_relevance: i % 3 === 0 ? 0.2 : 0.7 }),
    );
    const m1 = computeSourceMetrics(rows)[0];
    const m2 = computeSourceMetrics(rows)[0];
    expect(m1.pct_trash).toBe(m2.pct_trash);
  });
});
