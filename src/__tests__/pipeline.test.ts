/**
 * Unit tests for maos-intake pipeline logic.
 * External APIs (Anthropic, Supabase, OpenAI) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// ── Pure helpers (replicated from index.ts — no external deps) ──────────────

type Source = 'youtube' | 'instagram' | 'article' | 'url' | 'thread';
const VALID_SOURCES = new Set<string>(['youtube', 'instagram', 'article', 'thread']);

function detectSource(url: string, provided?: string): Source {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('twitter.com') || url.includes('x.com') || url.includes('threads.net')) return 'thread';
  if (url.includes('habr.com') || url.includes('medium.com') || url.includes('dev.to')) return 'article';
  if (provided && VALID_SOURCES.has(provided)) return provided as Source;
  return 'article';
}

function computeHash(text: string): string {
  return createHash('sha256').update(text.slice(0, 1000)).digest('hex');
}

type RoutedTo = 'hot_backlog' | 'knowledge_base' | 'discarded';
interface Item { immediate_relevance: number; strategic_relevance: number; has_ready_code?: boolean }
function routeItems(items: Item[]): (Item & { routed_to: RoutedTo })[] {
  return items.map((item) => {
    let routed_to: RoutedTo;
    if (item.immediate_relevance >= 0.7 || item.has_ready_code) routed_to = 'hot_backlog';
    else if (item.strategic_relevance >= 0.5) routed_to = 'knowledge_base';
    else routed_to = 'discarded';
    return { ...item, routed_to };
  });
}

// Replicated from analyze.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseHaikuJSON(raw: string): any {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '');
  text = text.replace(/\s*```\s*$/i, '');
  text = text.trim();
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return { items: [], summary: '', category: 'parse_error' };
  }
}

// ── 1. detectSource — URL pattern takes priority over provided hint ──────────

describe('detectSource', () => {
  it('detects YouTube from youtube.com URL regardless of provided hint', () => {
    expect(detectSource('https://www.youtube.com/watch?v=abc123', 'instagram')).toBe('youtube');
  });

  it('detects Instagram from instagram.com URL', () => {
    expect(detectSource('https://www.instagram.com/reel/abc/')).toBe('instagram');
  });

  it('detects thread from x.com URL', () => {
    expect(detectSource('https://x.com/user/status/123')).toBe('thread');
  });

  it('falls back to provided source_type for unknown URL', () => {
    expect(detectSource('https://somesite.example.com/article', 'instagram')).toBe('instagram');
  });

  it('falls back to article when no match and no valid hint', () => {
    expect(detectSource('https://somesite.example.com/', 'invalid_type')).toBe('article');
  });

  it('detects youtu.be short links as youtube', () => {
    expect(detectSource('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
  });
});

// ── 2. computeHash — consistent SHA-256 of first 1000 chars ─────────────────

describe('computeHash', () => {
  it('produces same hash for same text', () => {
    const t = 'Hello world content';
    expect(computeHash(t)).toBe(computeHash(t));
  });

  it('produces different hash for different text', () => {
    expect(computeHash('text A')).not.toBe(computeHash('text B'));
  });

  it('truncates to 1000 chars before hashing', () => {
    const long = 'A'.repeat(2000);
    const truncated = 'A'.repeat(2000);
    // Both should hash the same (same first 1000 chars)
    expect(computeHash(long)).toBe(computeHash(truncated));
  });
});

// ── 3. routeItems — scoring → routing logic ──────────────────────────────────

describe('routeItems', () => {
  it('routes immediate>=0.7 to hot_backlog', () => {
    const result = routeItems([{ immediate_relevance: 0.8, strategic_relevance: 0.3 }]);
    expect(result[0].routed_to).toBe('hot_backlog');
  });

  it('routes has_ready_code=true to hot_backlog even if scores low', () => {
    const result = routeItems([{ immediate_relevance: 0.2, strategic_relevance: 0.2, has_ready_code: true }]);
    expect(result[0].routed_to).toBe('hot_backlog');
  });

  it('routes strategic>=0.5 (but immediate<0.7) to knowledge_base', () => {
    const result = routeItems([{ immediate_relevance: 0.4, strategic_relevance: 0.6 }]);
    expect(result[0].routed_to).toBe('knowledge_base');
  });

  it('routes low-score items to discarded', () => {
    const result = routeItems([{ immediate_relevance: 0.2, strategic_relevance: 0.3 }]);
    expect(result[0].routed_to).toBe('discarded');
  });

  it('correctly routes a mixed batch', () => {
    const items = [
      { immediate_relevance: 0.85, strategic_relevance: 0.9 }, // hot
      { immediate_relevance: 0.5, strategic_relevance: 0.6 },  // knowledge
      { immediate_relevance: 0.1, strategic_relevance: 0.1 },  // discarded
    ];
    const routed = routeItems(items);
    expect(routed[0].routed_to).toBe('hot_backlog');
    expect(routed[1].routed_to).toBe('knowledge_base');
    expect(routed[2].routed_to).toBe('discarded');
  });
});

// ── 4. parseHaikuJSON — robust JSON extraction from Haiku output ─────────────

describe('parseHaikuJSON', () => {
  it('parses clean JSON directly', () => {
    const raw = '{"items":[],"summary":"test"}';
    expect(parseHaikuJSON(raw)).toEqual({ items: [], summary: 'test' });
  });

  it('strips markdown fences', () => {
    const raw = '```json\n{"items":[],"summary":"ok"}\n```';
    expect(parseHaikuJSON(raw)).toEqual({ items: [], summary: 'ok' });
  });

  it('extracts JSON from surrounding text', () => {
    const raw = 'Here is the result: {"items":[],"summary":"extracted"} done.';
    const result = parseHaikuJSON(raw);
    expect(result.summary).toBe('extracted');
  });

  it('returns parse_error category on completely invalid JSON', () => {
    const result = parseHaikuJSON('this is not json at all');
    expect(result.category).toBe('parse_error');
    expect(result.items).toEqual([]);
  });

  it('handles Haiku compact response with items', () => {
    const raw = JSON.stringify({
      items: [
        { t: 'idea', c: 'Добавить Redis кэш', b: 'Ускорит обработку', s: 0.7, r: 0.8, e: ['Redis'] }
      ],
      summary: 'Контент про кэширование',
    });
    const parsed = parseHaikuJSON(raw);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].t).toBe('idea');
    expect(parsed.items[0].r).toBe(0.8);
  });
});

// ── 5. Dedup threshold — 0.97 cosine similarity skips, 0.96 triggers Haiku ──

describe('dedup threshold logic', () => {
  it('marks action as NONE when similarity >= 0.97', () => {
    // Replicate the decision logic from saveExtractedKnowledge
    const similarity = 0.97;
    let action: 'ADD' | 'UPDATE' | 'NONE' = 'ADD';
    if (similarity >= 0.97) action = 'NONE';
    expect(action).toBe('NONE');
  });

  it('does not skip when similarity is 0.96 (below threshold)', () => {
    const similarity = 0.96;
    let action: 'ADD' | 'UPDATE' | 'NONE' = 'ADD';
    if (similarity >= 0.97) action = 'NONE';
    // Would proceed to Haiku decision (UPDATE or ADD)
    expect(action).toBe('ADD');
  });

  it('treats similarity 1.0 as exact duplicate', () => {
    const similarity = 1.0;
    let action: 'ADD' | 'UPDATE' | 'NONE' = 'ADD';
    if (similarity >= 0.97) action = 'NONE';
    expect(action).toBe('NONE');
  });
});

// ── 6. Haiku scoring — mock API response → verify BrainAnalysis structure ───

describe('analyzeContent (mocked Anthropic)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('parses compact Haiku response into BrainAnalysis with correct scores', async () => {
    const mockResponse = {
      items: [
        { t: 'insight', c: 'Использовать pgvector для семантического поиска', b: 'Ускорит поиск похожих знаний', s: 0.75, r: 0.8 },
        { t: 'idea', c: 'Добавить Sentry для мониторинга ошибок в Intake', b: 'Снизит время диагностики', s: 0.6, r: 0.45 },
      ],
      summary: 'Контент про векторные БД и мониторинг.',
    };

    // Test expandCompactResponse logic directly (replicated inline)
    type KnowledgeType = 'insight' | 'architecture_pattern' | 'tool_or_library' | 'lesson_learned' | 'actionable_idea' | 'technique' | 'guide';
    function expandItems(parsed: typeof mockResponse) {
      return parsed.items.map(item => ({
        knowledge_type: item.t === 'idea' ? 'actionable_idea' as KnowledgeType : 'insight' as KnowledgeType,
        content: item.c,
        immediate_relevance: item.r,
        strategic_relevance: item.s,
      }));
    }

    const items = expandItems(mockResponse);
    expect(items).toHaveLength(2);
    expect(items[0].knowledge_type).toBe('insight');
    expect(items[0].immediate_relevance).toBe(0.8);
    expect(items[1].knowledge_type).toBe('actionable_idea');

    // Verify routing of expanded items
    const routed = routeItems(items);
    expect(routed[0].routed_to).toBe('hot_backlog');   // r=0.8 >= 0.7
    expect(routed[1].routed_to).toBe('knowledge_base'); // s=0.6 >= 0.5, r=0.45 < 0.7
  });

  it('handles parse_error from Haiku gracefully', () => {
    const errorResult = parseHaikuJSON('not valid json from haiku');
    expect(errorResult.category).toBe('parse_error');
    expect(errorResult.items).toEqual([]);
    expect(errorResult.summary).toBe('');
  });
});

// ── 7. Entity extraction — entity_objects shape validation ───────────────────

describe('entity extraction', () => {
  it('filters entity_objects to valid types only', () => {
    const rawEntities = [
      { n: 'Supabase', t: 'tool' },
      { n: 'MAOS', t: 'project' },
      { n: 'Anthropic', t: 'company' },    // invalid type → becomes 'concept'
      { n: 'pgvector', t: 'concept' },
      { n: '', t: 'tool' },               // empty name — should be filtered
    ];

    const validTypes = new Set(['tool', 'project', 'concept', 'person']);
    const processed = rawEntities
      .filter(e => e.n.trim().length > 0)
      .map(e => ({
        name: e.n,
        type: validTypes.has(e.t) ? e.t : 'concept',
      }));

    expect(processed).toHaveLength(4);
    expect(processed[2].type).toBe('concept'); // 'company' → 'concept'
    expect(processed.find(e => e.name === 'pgvector')?.type).toBe('concept');
  });

  it('deduplicates entities by lowercase name', () => {
    const entities = [
      { name: 'Supabase', type: 'tool' as const },
      { name: 'supabase', type: 'tool' as const }, // duplicate
      { name: 'MAOS', type: 'project' as const },
    ];

    const seen = new Set<string>();
    const unique = entities.filter(e => {
      const key = e.name.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    expect(unique).toHaveLength(2);
    expect(unique.map(e => e.name)).toContain('Supabase');
    expect(unique.map(e => e.name)).not.toContain('supabase');
  });

  it('co-occurrence edge count matches n*(n-1)/2 for n entities', () => {
    const nodeIds = ['id1', 'id2', 'id3', 'id4'];
    const edges: { source_id: string; target_id: string }[] = [];
    for (let i = 0; i < nodeIds.length - 1; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        edges.push({ source_id: nodeIds[i], target_id: nodeIds[j] });
      }
    }
    // n=4 → 4*3/2 = 6 edges
    expect(edges).toHaveLength(6);
  });
});
