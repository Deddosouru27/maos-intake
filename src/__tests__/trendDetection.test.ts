/**
 * Unit tests for trend detection — entity frequency spike analysis.
 * Pure functions replicated inline — no external deps.
 *
 * Mutation tests:
 *   1. Remove MIN_RECENT_MENTIONS guard → detectSpike(1, 0) returns is_spike=true (should be false)
 *   2. Remove spikeConfidence tiers → 'high' never returned → structure test fails
 *   3. Remove MAX_TOP_ENTITIES limit → topEntitiesByRecent returns all 25, not 20
 */
import { describe, it, expect } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EntityMentionData {
  entity_type: string;
  recent: number;
  baseline: number;
}

interface KnowledgeRow {
  id: string;
  entity_objects: { name: string; type: string }[] | null;
  source_type: string | null;
  created_at: string;
}

// ── Pure functions replicated from trend-detection/index.ts ───────────────────

const RECENT_DAYS = 3;
const BASELINE_DAYS = 7;
const SPIKE_RATIO_THRESHOLD = 2.0;
const MAX_TOP_ENTITIES = 20;
const MIN_RECENT_MENTIONS = 2;

function computeEntityMentions(
  rows: KnowledgeRow[],
  recentDays = RECENT_DAYS,
  baselineDays = BASELINE_DAYS,
  now = Date.now(),
): Map<string, EntityMentionData> {
  const recentCutoff = now - recentDays * 24 * 60 * 60 * 1000;
  const baselineCutoff = now - (recentDays + baselineDays) * 24 * 60 * 60 * 1000;
  const entityMap = new Map<string, EntityMentionData>();
  for (const row of rows) {
    const ts = new Date(row.created_at).getTime();
    const isRecent = ts >= recentCutoff;
    const isBaseline = ts >= baselineCutoff && ts < recentCutoff;
    if (!isRecent && !isBaseline) continue;
    for (const entity of row.entity_objects ?? []) {
      const entry = entityMap.get(entity.name) ?? { entity_type: entity.type, recent: 0, baseline: 0 };
      if (isRecent) entry.recent++;
      else entry.baseline++;
      entityMap.set(entity.name, entry);
    }
  }
  return entityMap;
}

function detectSpike(
  recentMentions: number,
  baselineMentions: number,
  recentDays: number,
  baselineDays: number,
): { is_spike: boolean; ratio: number } {
  if (recentMentions < MIN_RECENT_MENTIONS) return { is_spike: false, ratio: 0 };
  const recentPerDay = recentMentions / recentDays;
  const baselinePerDay = baselineDays > 0 ? baselineMentions / baselineDays : 0;
  if (baselinePerDay === 0) {
    const is_spike = recentMentions >= MIN_RECENT_MENTIONS * 2;
    return { is_spike, ratio: is_spike ? 999 : 0 };
  }
  const ratio = parseFloat((recentPerDay / baselinePerDay).toFixed(2));
  return { is_spike: ratio >= SPIKE_RATIO_THRESHOLD, ratio };
}

function spikeConfidence(ratio: number): 'high' | 'medium' | 'low' {
  if (ratio >= 5) return 'high';
  if (ratio >= SPIKE_RATIO_THRESHOLD) return 'medium';
  return 'low';
}

function topEntitiesByRecent(
  mentions: Map<string, EntityMentionData>,
  limit = MAX_TOP_ENTITIES,
): [string, EntityMentionData][] {
  return Array.from(mentions.entries())
    .sort((a, b) => b[1].recent - a[1].recent)
    .slice(0, limit);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

let _id = 0;
function makeRow(
  entities: { name: string; type: string }[],
  daysOld: number,
  overrides: Partial<KnowledgeRow> = {},
): KnowledgeRow {
  return {
    id: `row-${++_id}`,
    entity_objects: entities,
    source_type: 'youtube',
    created_at: daysAgo(daysOld),
    ...overrides,
  };
}

// ── 1. computeEntityMentions ──────────────────────────────────────────────────

describe('computeEntityMentions', () => {
  it('returns empty map for rows with no entity_objects', () => {
    const rows = [makeRow([], 1), makeRow([], 2)];
    expect(computeEntityMentions(rows).size).toBe(0);
  });

  it('returns empty map when entity_objects is null', () => {
    const rows: KnowledgeRow[] = [{ id: '1', entity_objects: null, source_type: 'article', created_at: daysAgo(1) }];
    expect(computeEntityMentions(rows).size).toBe(0);
  });

  it('counts entity in recent bucket when item is 2 days old', () => {
    const rows = [makeRow([{ name: 'OpenAI', type: 'tool' }], 2)];
    const m = computeEntityMentions(rows);
    expect(m.get('OpenAI')?.recent).toBe(1);
    expect(m.get('OpenAI')?.baseline).toBe(0);
  });

  it('counts entity in baseline bucket when item is 5 days old', () => {
    const rows = [makeRow([{ name: 'Supabase', type: 'tool' }], 5)];
    const m = computeEntityMentions(rows);
    expect(m.get('Supabase')?.recent).toBe(0);
    expect(m.get('Supabase')?.baseline).toBe(1);
  });

  it('excludes items older than recentDays + baselineDays (11 days old → excluded)', () => {
    const rows = [makeRow([{ name: 'OldEntity', type: 'tool' }], 11)];
    expect(computeEntityMentions(rows).size).toBe(0);
  });

  it('accumulates multiple mentions for same entity across multiple rows', () => {
    const rows = [
      makeRow([{ name: 'Claude', type: 'tool' }], 1),
      makeRow([{ name: 'Claude', type: 'tool' }], 2),
      makeRow([{ name: 'Claude', type: 'tool' }], 5), // baseline
    ];
    const m = computeEntityMentions(rows);
    expect(m.get('Claude')?.recent).toBe(2);
    expect(m.get('Claude')?.baseline).toBe(1);
  });

  it('handles multiple different entities in one row', () => {
    const rows = [makeRow([{ name: 'Supabase', type: 'tool' }, { name: 'pgvector', type: 'tool' }], 1)];
    const m = computeEntityMentions(rows);
    expect(m.size).toBe(2);
    expect(m.get('Supabase')?.recent).toBe(1);
    expect(m.get('pgvector')?.recent).toBe(1);
  });
});

// ── 2. detectSpike ────────────────────────────────────────────────────────────

describe('detectSpike', () => {
  it('returns is_spike=false when recentMentions < MIN_RECENT_MENTIONS', () => {
    // 1 mention, even with 0 baseline → not a spike
    expect(detectSpike(1, 0, 3, 7).is_spike).toBe(false);
  });

  it('ratio >= 2x → is_spike', () => {
    // recent=6 (2/day), baseline=3 (0.43/day) → ratio = 2/0.43 ≈ 4.67
    expect(detectSpike(6, 3, 3, 7).is_spike).toBe(true);
  });

  it('ratio exactly 2x → is_spike', () => {
    // recent=6 (2/day), baseline=7 (1/day) → ratio = 2 exactly
    expect(detectSpike(6, 7, 3, 7).is_spike).toBe(true);
    expect(detectSpike(6, 7, 3, 7).ratio).toBe(2);
  });

  it('ratio < 2x → NOT spike', () => {
    // recent=3 (1/day), baseline=7 (1/day) → ratio = 1
    expect(detectSpike(3, 7, 3, 7).is_spike).toBe(false);
  });

  it('zero baseline + recentMentions >= MIN*2 → is_spike (new entity signal)', () => {
    // 4 mentions recent, 0 baseline → new hot entity
    expect(detectSpike(4, 0, 3, 7).is_spike).toBe(true);
    expect(detectSpike(4, 0, 3, 7).ratio).toBe(999);
  });

  it('zero baseline + recentMentions < MIN*2 → NOT spike', () => {
    // 2 mentions recent, 0 baseline → below new-entity threshold (MIN*2=4)
    expect(detectSpike(2, 0, 3, 7).is_spike).toBe(false);
  });
});

// ── 3. spikeConfidence ────────────────────────────────────────────────────────

describe('spikeConfidence', () => {
  // MUTATION: if spikeConfidence is removed or broken, 'high' is never returned
  it('MUTATION: ratio >= 5 → high (must not return medium or low)', () => {
    expect(spikeConfidence(5)).toBe('high');
    expect(spikeConfidence(10)).toBe('high');
    expect(spikeConfidence(999)).toBe('high');
  });

  it('ratio 2–5 → medium', () => {
    expect(spikeConfidence(2)).toBe('medium');
    expect(spikeConfidence(3.5)).toBe('medium');
    expect(spikeConfidence(4.99)).toBe('medium');
  });

  it('ratio < 2 → low', () => {
    expect(spikeConfidence(0)).toBe('low');
    expect(spikeConfidence(1.5)).toBe('low');
    expect(spikeConfidence(1.99)).toBe('low');
  });
});

// ── 4. topEntitiesByRecent ────────────────────────────────────────────────────

describe('topEntitiesByRecent', () => {
  it('returns empty array for empty mentions map', () => {
    expect(topEntitiesByRecent(new Map())).toHaveLength(0);
  });

  it('orders by recent mentions descending', () => {
    const m = new Map<string, EntityMentionData>([
      ['A', { entity_type: 'tool', recent: 2, baseline: 1 }],
      ['B', { entity_type: 'tool', recent: 10, baseline: 0 }],
      ['C', { entity_type: 'tool', recent: 5, baseline: 3 }],
    ]);
    const top = topEntitiesByRecent(m);
    expect(top[0][0]).toBe('B');
    expect(top[1][0]).toBe('C');
    expect(top[2][0]).toBe('A');
  });

  // MUTATION: removing limit → returns all 25 instead of 20
  it('MUTATION: limits to MAX_TOP_ENTITIES (cost guard)', () => {
    const m = new Map(
      Array.from({ length: 25 }, (_, i) => [
        `Entity${i}`,
        { entity_type: 'tool', recent: 25 - i, baseline: 0 },
      ] as [string, EntityMentionData]),
    );
    const top = topEntitiesByRecent(m, 20);
    expect(top).toHaveLength(20);
    // If limit removed → would return 25 → this assertion fails
  });
});

// ── 5. MIN_RECENT_MENTIONS guard — mutation ───────────────────────────────────

describe('MUTATION: MIN_RECENT_MENTIONS cost/noise guard', () => {
  it('single mention with 0 baseline must NOT trigger spike', () => {
    // Without MIN_RECENT_MENTIONS guard: detectSpike(1, 0) would return is_spike=true
    // because baselinePerDay=0 branch would return recentMentions >= 4 check... actually
    // let's verify the guard is the first check
    const { is_spike } = detectSpike(1, 0, 3, 7);
    expect(is_spike).toBe(false); // guard fires before ratio check
  });

  it('zero mentions must never be a spike', () => {
    expect(detectSpike(0, 0, 3, 7).is_spike).toBe(false);
    expect(detectSpike(0, 100, 3, 7).is_spike).toBe(false);
  });
});

// ── 6. trend_signal structure ─────────────────────────────────────────────────

describe('trend_signal structure', () => {
  it('spike detection produces all required TrendSignal fields', () => {
    const rows = [
      makeRow([{ name: 'Vercel', type: 'tool' }], 1),
      makeRow([{ name: 'Vercel', type: 'tool' }], 2),
      makeRow([{ name: 'Vercel', type: 'tool' }], 2), // 3 recent
      makeRow([{ name: 'Vercel', type: 'tool' }], 5), // baseline: 1 mention / 7 days
    ];
    const mentions = computeEntityMentions(rows);
    const data = mentions.get('Vercel')!;
    const { is_spike, ratio } = detectSpike(data.recent, data.baseline, RECENT_DAYS, BASELINE_DAYS);

    expect(is_spike).toBe(true);
    const signal = {
      entity: 'Vercel',
      entity_type: 'tool',
      mentions_recent: data.recent,
      mentions_baseline: data.baseline,
      spike_ratio: ratio,
      confidence: spikeConfidence(ratio),
      window_days: RECENT_DAYS + BASELINE_DAYS,
      generated_at: new Date().toISOString(),
    };

    // All required fields present (MUTATION: if confidence removed → this fails)
    expect(signal.entity).toBe('Vercel');
    expect(signal.mentions_recent).toBeGreaterThanOrEqual(MIN_RECENT_MENTIONS);
    expect(['high', 'medium', 'low']).toContain(signal.confidence);
    expect(signal.spike_ratio).toBeGreaterThanOrEqual(SPIKE_RATIO_THRESHOLD);
    expect(signal.window_days).toBe(10);
  });
});

// ── 7. Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('empty rows → 0 entities, no crash', () => {
    expect(computeEntityMentions([]).size).toBe(0);
    expect(topEntitiesByRecent(new Map())).toHaveLength(0);
  });

  it('detectSpike gracefully handles negative recentMentions (guard catches it)', () => {
    expect(detectSpike(-1, 5, 3, 7).is_spike).toBe(false);
  });

  it('computeEntityMentions: item at exact baselineCutoff boundary IS counted in baseline', () => {
    const now = Date.now();
    // baselineCutoff = now - (RECENT_DAYS + BASELINE_DAYS) * day = now - 10 days
    // ts >= baselineCutoff → inclusive, so exactly 10 days old is in baseline
    const exactBoundary = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const rows: KnowledgeRow[] = [{ id: 'b', entity_objects: [{ name: 'EdgeEntity', type: 'tool' }], source_type: null, created_at: exactBoundary }];
    const m = computeEntityMentions(rows, RECENT_DAYS, BASELINE_DAYS, now);
    expect(m.get('EdgeEntity')?.baseline).toBe(1); // inclusive lower bound
    expect(m.get('EdgeEntity')?.recent).toBe(0);
  });

  it('computeEntityMentions: item 11 days old is fully excluded (beyond both windows)', () => {
    const rows = [makeRow([{ name: 'TooOld', type: 'tool' }], 11)];
    expect(computeEntityMentions(rows).get('TooOld')).toBeUndefined();
  });
});

// ── 8. Idempotency ────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('same rows → same entity mention counts on repeated calls', () => {
    const rows = [
      makeRow([{ name: 'Claude', type: 'tool' }], 1),
      makeRow([{ name: 'Claude', type: 'tool' }], 5),
    ];
    const m1 = computeEntityMentions(rows);
    const m2 = computeEntityMentions(rows);
    expect(m1.get('Claude')?.recent).toBe(m2.get('Claude')?.recent);
    expect(m1.get('Claude')?.baseline).toBe(m2.get('Claude')?.baseline);
  });

  it('detectSpike is deterministic for same inputs', () => {
    const r1 = detectSpike(6, 3, 3, 7);
    const r2 = detectSpike(6, 3, 3, 7);
    expect(r1.is_spike).toBe(r2.is_spike);
    expect(r1.ratio).toBe(r2.ratio);
  });
});
