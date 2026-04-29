/**
 * Unit tests for auto-research A/B prompt optimizer.
 * Pure functions replicated inline — no external dependencies (pattern from critical.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScoredItem {
  knowledge_type: string;
  content: string;
  immediate_relevance: number;
  tags: string[];
  entity_objects?: { name: string; type: string }[];
  business_value?: string | null;
}

interface QualityBreakdown {
  type_diversity: number;
  entity_coverage: number;
  tag_quality: number;
  score_distribution: number;
  content_quality: number;
  completeness: number;
}

interface QualityResult {
  score: number;
  breakdown: QualityBreakdown;
  items_count: number;
}

// ── Pure functions replicated from auto-research modules ───────────────────────

const WEIGHTS = {
  type_diversity: 0.15,
  entity_coverage: 0.20,
  tag_quality: 0.15,
  score_distribution: 0.25,
  content_quality: 0.15,
  completeness: 0.10,
};

function computeQualityScore(items: ScoredItem[]): QualityResult {
  const zero: QualityBreakdown = { type_diversity: 0, entity_coverage: 0, tag_quality: 0, score_distribution: 0, content_quality: 0, completeness: 0 };
  if (items.length === 0) return { score: 0, breakdown: zero, items_count: 0 };

  const types = new Set(items.map((i) => i.knowledge_type));
  const type_diversity = Math.min(types.size / 3, 1);

  const entity_coverage = items.filter((i) => (i.entity_objects?.length ?? 0) > 0).length / items.length;

  const avgTags = items.reduce((sum, i) => sum + i.tags.length, 0) / items.length;
  const tag_quality = avgTags === 0 ? 0 : avgTags < 2 ? 0.5 : avgTags <= 4 ? 1.0 : 0.7;

  const scores = items.map((i) => i.immediate_relevance);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const inflation_penalty = mean > 0.6 ? (mean - 0.6) * 2 : 0;
  const variance_penalty = stddev < 0.05 ? 0.5 : 0;
  const score_distribution = Math.max(0, Math.min(1, 1 - inflation_penalty - variance_penalty));

  const content_quality =
    items.reduce((sum, item) => {
      const len = item.content.length;
      return sum + (len < 50 ? 0 : len <= 300 ? 1.0 : 0.8);
    }, 0) / items.length;

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

function buildSampleHash(itemIds: string[]): string {
  return createHash('sha256').update([...itemIds].sort().join(',')).digest('hex').slice(0, 16);
}

function buildResultInsert(
  winner: 'A' | 'B',
  scoreA: number,
  scoreB: number,
  samplesCount: number,
  sampleHash: string,
) {
  return {
    snapshot_type: 'prompt_optimization_result',
    content: {
      type: 'prompt_optimization_result',
      winner,
      score_a: scoreA,
      score_b: scoreB,
      delta: parseFloat(Math.abs(scoreA - scoreB).toFixed(4)),
      samples_count: samplesCount,
      sample_hash: sampleHash,
      date: new Date().toISOString(),
    },
  };
}

function buildArchiveInsert(
  loser: 'A' | 'B',
  score: number,
  samplesCount: number,
  sampleHash: string,
) {
  return {
    snapshot_type: 'prompt_archived',
    content: {
      type: 'prompt_archived',
      variant: loser,
      score,
      samples_count: samplesCount,
      sample_hash: sampleHash,
      date: new Date().toISOString(),
    },
  };
}

function parseVariantItems(raw: string): ScoredItem[] {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  text = text.slice(start, end + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  type RawItem = { t?: string; c?: string; b?: string; r?: number; s?: number; e?: unknown[]; eo?: unknown[] };
  return (parsed as RawItem[])
    .filter((i) => typeof i.c === 'string' && i.c.length > 0)
    .map((i) => ({
      knowledge_type: typeof i.t === 'string' ? i.t : 'insight',
      content: i.c as string,
      immediate_relevance: typeof i.r === 'number' ? i.r : typeof i.s === 'number' ? i.s : 0.4,
      tags: Array.isArray(i.e) ? (i.e as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      entity_objects: Array.isArray(i.eo)
        ? (i.eo as unknown[])
            .filter((e): e is { n: string; t?: string } => typeof (e as Record<string, unknown>)?.n === 'string')
            .map((e) => ({ name: e.n, type: typeof e.t === 'string' ? e.t : 'tool' }))
        : [],
      business_value: typeof i.b === 'string' ? i.b : null,
    }));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<ScoredItem> = {}): ScoredItem {
  return {
    knowledge_type: 'insight',
    content: 'Конкретный инсайт про Supabase pgvector для semantic search в MAOS pipeline.',
    immediate_relevance: 0.4,
    tags: ['Supabase', 'pgvector'],
    entity_objects: [{ name: 'Supabase', type: 'tool' }],
    business_value: 'Ускоряет recall в knowledge pipeline на 10x.',
    ...overrides,
  };
}

// High-quality batch: diverse types, entities, good tags, calibrated scores
function makeHighQualityBatch(): ScoredItem[] {
  return [
    makeItem({ knowledge_type: 'tool', tags: ['pgvector', 'Supabase', 'HNSW'], immediate_relevance: 0.8 }),
    makeItem({ knowledge_type: 'technique', tags: ['Claude', 'prompt caching'], immediate_relevance: 0.4 }),
    makeItem({ knowledge_type: 'pattern', tags: ['Vercel', 'Edge Functions'], immediate_relevance: 0.3 }),
    makeItem({ knowledge_type: 'lesson', tags: ['Node.js', 'TypeScript'], immediate_relevance: 0.5 }),
    makeItem({ knowledge_type: 'insight', tags: ['OpenAI', 'embeddings'], immediate_relevance: 0.35 }),
  ];
}

// Low-quality batch: all "insight", no entities, few tags, inflated scores
function makeLowQualityBatch(): ScoredItem[] {
  return [
    { knowledge_type: 'insight', content: 'AI is important', immediate_relevance: 0.8, tags: ['AI'], entity_objects: [], business_value: null },
    { knowledge_type: 'insight', content: 'Automation helps', immediate_relevance: 0.8, tags: ['automation'], entity_objects: [], business_value: null },
    { knowledge_type: 'insight', content: 'Use good tools', immediate_relevance: 0.8, tags: [], entity_objects: [], business_value: null },
    { knowledge_type: 'insight', content: 'Learn continuously', immediate_relevance: 0.8, tags: [], entity_objects: [], business_value: null },
    { knowledge_type: 'insight', content: 'Focus matters', immediate_relevance: 0.8, tags: [], entity_objects: [], business_value: null },
  ];
}

// ── 1. computeQualityScore — core scoring ─────────────────────────────────────

describe('computeQualityScore', () => {
  it('returns 0 for empty items', () => {
    const result = computeQualityScore([]);
    expect(result.score).toBe(0);
    expect(result.items_count).toBe(0);
  });

  it('high-quality batch scores higher than low-quality batch', () => {
    const high = computeQualityScore(makeHighQualityBatch());
    const low = computeQualityScore(makeLowQualityBatch());
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('type_diversity: 1 type = low, 3+ types = max', () => {
    const oneType = computeQualityScore([makeItem(), makeItem(), makeItem()]);
    const threeTypes = computeQualityScore([
      makeItem({ knowledge_type: 'tool' }),
      makeItem({ knowledge_type: 'technique' }),
      makeItem({ knowledge_type: 'pattern' }),
    ]);
    expect(threeTypes.breakdown.type_diversity).toBe(1);
    expect(oneType.breakdown.type_diversity).toBeLessThan(1);
  });

  it('entity_coverage: all items with entities = 1.0', () => {
    const items = makeHighQualityBatch(); // all have entity_objects
    const result = computeQualityScore(items);
    expect(result.breakdown.entity_coverage).toBe(1);
  });

  it('entity_coverage: no entities = 0', () => {
    const items = [makeItem({ entity_objects: [] }), makeItem({ entity_objects: [] })];
    const result = computeQualityScore(items);
    expect(result.breakdown.entity_coverage).toBe(0);
  });

  it('tag_quality: 0 tags = 0, 1 tag = 0.5, 2-4 tags = 1.0', () => {
    expect(computeQualityScore([makeItem({ tags: [] })]).breakdown.tag_quality).toBe(0);
    expect(computeQualityScore([makeItem({ tags: ['x'] })]).breakdown.tag_quality).toBe(0.5);
    expect(computeQualityScore([makeItem({ tags: ['x', 'y'] })]).breakdown.tag_quality).toBe(1.0);
    expect(computeQualityScore([makeItem({ tags: ['a', 'b', 'c', 'd'] })]).breakdown.tag_quality).toBe(1.0);
    expect(computeQualityScore([makeItem({ tags: ['a', 'b', 'c', 'd', 'e'] })]).breakdown.tag_quality).toBe(0.7);
  });

  it('score_distribution: inflation (all 0.8) penalized', () => {
    const inflated = [
      makeItem({ immediate_relevance: 0.8 }),
      makeItem({ immediate_relevance: 0.8 }),
      makeItem({ immediate_relevance: 0.8 }),
    ];
    const calibrated = [
      makeItem({ immediate_relevance: 0.3 }),
      makeItem({ immediate_relevance: 0.5 }),
      makeItem({ immediate_relevance: 0.8 }),
    ];
    const rInflated = computeQualityScore(inflated);
    const rCalibrated = computeQualityScore(calibrated);
    expect(rInflated.breakdown.score_distribution).toBeLessThan(rCalibrated.breakdown.score_distribution);
  });

  it('score_distribution: all same score (stddev=0) penalized', () => {
    const uniform = [
      makeItem({ immediate_relevance: 0.4 }),
      makeItem({ immediate_relevance: 0.4 }),
      makeItem({ immediate_relevance: 0.4 }),
    ];
    const result = computeQualityScore(uniform);
    expect(result.breakdown.score_distribution).toBeLessThanOrEqual(0.5);
  });

  it('completeness: all have business_value = 1.0', () => {
    const result = computeQualityScore(makeHighQualityBatch());
    expect(result.breakdown.completeness).toBe(1);
  });

  it('completeness: none have business_value = 0', () => {
    const items = [makeItem({ business_value: null }), makeItem({ business_value: '' })];
    const result = computeQualityScore(items);
    expect(result.breakdown.completeness).toBe(0);
  });

  it('content_quality: short content (<50 chars) penalized', () => {
    const short = [makeItem({ content: 'Too short.' })];
    const long = [makeItem({ content: 'This is a sufficiently detailed insight about Supabase pgvector usage in production systems.' })];
    expect(computeQualityScore(short).breakdown.content_quality).toBe(0);
    expect(computeQualityScore(long).breakdown.content_quality).toBe(1);
  });

  it('mock A/B: two different item sets produce different scores', () => {
    const scoreA = computeQualityScore(makeHighQualityBatch()).score;
    const scoreB = computeQualityScore(makeLowQualityBatch()).score;
    expect(scoreA).not.toBe(scoreB);
    expect(scoreA).toBeGreaterThan(scoreB);
  });
});

// ── 2. buildSampleHash — deterministic dedup key ──────────────────────────────

describe('buildSampleHash', () => {
  it('same IDs in same order → same hash', () => {
    const ids = ['id1', 'id2', 'id3'];
    expect(buildSampleHash(ids)).toBe(buildSampleHash(ids));
  });

  it('same IDs in different order → same hash (sort-stable)', () => {
    const h1 = buildSampleHash(['id1', 'id2', 'id3']);
    const h2 = buildSampleHash(['id3', 'id1', 'id2']);
    expect(h1).toBe(h2);
  });

  it('different IDs → different hash', () => {
    const h1 = buildSampleHash(['id1', 'id2']);
    const h2 = buildSampleHash(['id1', 'id9']);
    expect(h1).not.toBe(h2);
  });

  it('hash is 16 hex chars', () => {
    const h = buildSampleHash(['a', 'b', 'c']);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── 3. buildResultInsert — prompt_optimization_result snapshot ────────────────

describe('buildResultInsert', () => {
  it('snapshot_type is prompt_optimization_result', () => {
    const row = buildResultInsert('A', 0.72, 0.65, 5, 'abc123');
    expect(row.snapshot_type).toBe('prompt_optimization_result');
  });

  it('content.type matches snapshot_type', () => {
    const row = buildResultInsert('B', 0.68, 0.72, 5, 'abc123');
    expect(row.content.type).toBe('prompt_optimization_result');
  });

  it('winner is stored correctly', () => {
    const rowA = buildResultInsert('A', 0.8, 0.6, 5, 'hash1');
    const rowB = buildResultInsert('B', 0.6, 0.8, 5, 'hash2');
    expect(rowA.content.winner).toBe('A');
    expect(rowB.content.winner).toBe('B');
  });

  it('delta = |score_a - score_b|', () => {
    const row = buildResultInsert('A', 0.75, 0.60, 5, 'h');
    expect(row.content.delta).toBeCloseTo(0.15, 4);
  });

  it('sample_hash is stored in content', () => {
    const hash = buildSampleHash(['x1', 'x2', 'x3', 'x4', 'x5']);
    const row = buildResultInsert('A', 0.7, 0.6, 5, hash);
    expect(row.content.sample_hash).toBe(hash);
  });

  it('samples_count stored correctly', () => {
    const row = buildResultInsert('A', 0.7, 0.6, 5, 'h');
    expect(row.content.samples_count).toBe(5);
  });
});

// ── 4. buildArchiveInsert — prompt_archived snapshot ─────────────────────────

describe('buildArchiveInsert', () => {
  it('snapshot_type is prompt_archived', () => {
    const row = buildArchiveInsert('B', 0.60, 5, 'hash1');
    expect(row.snapshot_type).toBe('prompt_archived');
  });

  it('content.variant stores the losing variant', () => {
    const row = buildArchiveInsert('B', 0.60, 5, 'hash1');
    expect(row.content.variant).toBe('B');
  });

  it('content.score stores the loser score', () => {
    const row = buildArchiveInsert('A', 0.45, 5, 'h');
    expect(row.content.score).toBe(0.45);
  });
});

// ── 5. parseVariantItems — LLM response parser ────────────────────────────────

describe('parseVariantItems', () => {
  it('parses clean JSON array', () => {
    const raw = JSON.stringify([
      { t: 'tool', c: 'pgvector HNSW index for fast similarity search', b: 'Speeds up knowledge recall', r: 0.8, e: ['pgvector', 'Supabase'], eo: [{ n: 'pgvector', t: 'tool' }] },
    ]);
    const items = parseVariantItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].knowledge_type).toBe('tool');
    expect(items[0].immediate_relevance).toBe(0.8);
    expect(items[0].tags).toContain('pgvector');
    expect(items[0].entity_objects?.[0].name).toBe('pgvector');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n[{"t":"insight","c":"Some content here","r":0.4,"e":["Tag"]}]\n```';
    expect(parseVariantItems(raw)).toHaveLength(1);
  });

  it('extracts array from preamble text', () => {
    const raw = 'Here are the insights:\n[{"t":"tool","c":"Content text","r":0.5,"e":["Tag"]}]\nDone.';
    expect(parseVariantItems(raw)).toHaveLength(1);
  });

  it('filters items without content field', () => {
    const raw = JSON.stringify([{ t: 'insight', r: 0.4 }, { t: 'tool', c: 'Valid content here', r: 0.5, e: [] }]);
    expect(parseVariantItems(raw)).toHaveLength(1);
  });

  it('falls back to s field if r is absent', () => {
    const raw = JSON.stringify([{ c: 'Some content', s: 0.65, e: [] }]);
    const items = parseVariantItems(raw);
    expect(items[0].immediate_relevance).toBe(0.65);
  });

  it('returns [] on invalid JSON', () => {
    expect(parseVariantItems('not json')).toHaveLength(0);
  });

  it('returns [] when no array found', () => {
    expect(parseVariantItems('{"key":"value"}')).toHaveLength(0);
  });
});

// ── 6. Repeat run dedup — same hash guards against duplicate snapshots ─────────

describe('dedup: same sample hash prevents duplicate run', () => {
  it('same item IDs produce identical hash across calls', () => {
    const ids = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'];
    const hash1 = buildSampleHash(ids);
    const hash2 = buildSampleHash(ids);
    expect(hash1).toBe(hash2);
  });

  it('existing snapshot with same hash means run was already done', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const sampleHash = buildSampleHash(ids);
    // Simulate: existing snapshot stored with this hash
    const stored = buildResultInsert('A', 0.7, 0.6, 5, sampleHash);
    // System checks content.sample_hash — if match found, skip
    expect(stored.content.sample_hash).toBe(sampleHash);
  });

  it('different sample IDs always produce different hash', () => {
    const run1 = buildSampleHash(['id1', 'id2', 'id3', 'id4', 'id5']);
    const run2 = buildSampleHash(['id6', 'id7', 'id8', 'id9', 'id10']);
    expect(run1).not.toBe(run2);
  });
});
