/**
 * Unit tests for lessonsExtractor — weekly auto-learning from gotchas/findings.
 * Pure functions replicated inline — no external dependencies (pattern from critical.test.ts).
 */
import { describe, it, expect } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawSnapshot {
  id: string;
  snapshot_type: string;
  content: Record<string, unknown>;
  created_at: string;
}

interface ExtractedLesson {
  rule_id: string;
  pattern_observed: string;
  principle: string;
  prevention_rule: string;
}

// ── Pure functions replicated from lessonsExtractor.ts ────────────────────────

function buildLessonsPrompt(snapshots: RawSnapshot[]): string {
  const summaries = snapshots.map((s, i) => {
    const c = s.content;
    const title = String(c.title ?? c.rule ?? s.snapshot_type);
    const concern = String(c.concern ?? c.description ?? c.finding ?? c.error ?? '');
    const fix = String(c.fix_pattern ?? c.fix ?? c.prevention ?? c.prevention_rule ?? '');
    const lines = [`${i + 1}. [${s.snapshot_type}] ${title}`];
    if (concern) lines.push(`   Проблема: ${concern.slice(0, 200)}`);
    if (fix) lines.push(`   Фикс: ${fix.slice(0, 150)}`);
    return lines.join('\n');
  }).join('\n\n');

  return `Прочитай эти ${snapshots.length} записей про ошибки и находки за неделю. Найди ОБЩИЕ ПАТТЕРНЫ (не каждую ошибку отдельно). Сформулируй 3-5 универсальных правил которые предотвратят повторение похожих ошибок.

Записи:
${summaries}

Формат ответа — JSON массив, без preamble:
[{"rule_id":"snake_case_short","pattern_observed":"что повторяется","principle":"какой принцип нарушен","prevention_rule":"как избежать"}]`;
}

function parseLessonsResponse(raw: string): ExtractedLesson[] {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('LLM response is not a JSON array');
  return parsed.filter(
    (item): item is ExtractedLesson =>
      typeof item === 'object' && item !== null &&
      typeof (item as ExtractedLesson).rule_id === 'string' &&
      typeof (item as ExtractedLesson).prevention_rule === 'string',
  );
}

const MIN_SNAPSHOTS = 5;

function shouldExtract(count: number): boolean {
  return count >= MIN_SNAPSHOTS;
}

function buildLessonInsert(lesson: ExtractedLesson, snapshotsAnalyzed: number) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    snapshot_type: 'lesson',
    content: {
      type: 'lesson',
      rule: `auto_lesson_${lesson.rule_id}_${date}`,
      rule_id: lesson.rule_id,
      pattern_observed: lesson.pattern_observed,
      principle: lesson.principle,
      prevention_rule: lesson.prevention_rule,
      source: 'weekly_auto_extraction',
      snapshots_analyzed: snapshotsAnalyzed,
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSnapshot(type: 'gotcha' | 'finding', overrides: Partial<Record<string, unknown>> = {}): RawSnapshot {
  return {
    id: Math.random().toString(36).slice(2),
    snapshot_type: type,
    content: {
      type,
      title: `Test ${type}`,
      concern: 'Something went wrong repeatedly',
      fix_pattern: 'Check before proceeding',
      ...overrides,
    },
    created_at: new Date().toISOString(),
  };
}

function make10Gotchas(): RawSnapshot[] {
  return Array.from({ length: 10 }, (_, i) => makeSnapshot(
    i % 2 === 0 ? 'gotcha' : 'finding',
    { title: `Error pattern ${i + 1}`, concern: `Problem description ${i + 1}`, fix_pattern: `Fix approach ${i + 1}` },
  ));
}

// ── 1. buildLessonsPrompt ─────────────────────────────────────────────────────

describe('buildLessonsPrompt', () => {
  it('includes snapshot count in prompt', () => {
    const prompt = buildLessonsPrompt(make10Gotchas());
    expect(prompt).toContain('10 записей');
  });

  it('includes title from each snapshot', () => {
    const snapshots = [makeSnapshot('gotcha', { title: 'Unique test title ABC' })];
    const prompt = buildLessonsPrompt(snapshots);
    expect(prompt).toContain('Unique test title ABC');
  });

  it('truncates concern to 200 chars max', () => {
    const longConcern = 'x'.repeat(300);
    const snapshots = [makeSnapshot('gotcha', { concern: longConcern })];
    const prompt = buildLessonsPrompt(snapshots);
    expect(prompt).toContain('x'.repeat(200));
    expect(prompt).not.toContain('x'.repeat(201));
  });

  it('truncates fix to 150 chars max', () => {
    const longFix = 'f'.repeat(200);
    const snapshots = [makeSnapshot('gotcha', { fix_pattern: longFix })];
    const prompt = buildLessonsPrompt(snapshots);
    expect(prompt).toContain('f'.repeat(150));
    expect(prompt).not.toContain('f'.repeat(151));
  });

  it('falls back to rule field when title is absent', () => {
    const snapshots = [{ id: '1', snapshot_type: 'gotcha', content: { rule: 'my_rule_fallback' }, created_at: '' }];
    const prompt = buildLessonsPrompt(snapshots);
    expect(prompt).toContain('my_rule_fallback');
  });

  it('contains required JSON format hint', () => {
    const prompt = buildLessonsPrompt(make10Gotchas());
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toContain('"prevention_rule"');
  });

  it('does not expose sensitive override keys — only known safe fields', () => {
    // Only title/concern/fix_pattern fields are extracted — other keys ignored
    const snapshots = [makeSnapshot('gotcha', { api_key: 'sk-secret-123', token: 'bearer-abc' })];
    const prompt = buildLessonsPrompt(snapshots);
    expect(prompt).not.toContain('sk-secret-123');
    expect(prompt).not.toContain('bearer-abc');
  });
});

// ── 2. parseLessonsResponse ───────────────────────────────────────────────────

describe('parseLessonsResponse', () => {
  const validLessons: ExtractedLesson[] = [
    { rule_id: 'always_validate_input', pattern_observed: 'Missing validation before DB calls', principle: 'Fail fast', prevention_rule: 'Add schema validation at API boundary' },
    { rule_id: 'log_not_swallow', pattern_observed: 'Errors silently ignored in catch blocks', principle: 'Observability', prevention_rule: 'Always log the error message before continuing' },
  ];

  it('parses clean JSON array', () => {
    const result = parseLessonsResponse(JSON.stringify(validLessons));
    expect(result).toHaveLength(2);
    expect(result[0].rule_id).toBe('always_validate_input');
    expect(result[1].prevention_rule).toBe('Always log the error message before continuing');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify(validLessons) + '\n```';
    expect(parseLessonsResponse(raw)).toHaveLength(2);
  });

  it('extracts array from preamble text (LLM adds explanation)', () => {
    const raw = 'Sure, here are the lessons:\n' + JSON.stringify(validLessons) + '\nDone.';
    expect(parseLessonsResponse(raw)).toHaveLength(2);
  });

  it('filters out items missing rule_id', () => {
    const mixed = [
      { rule_id: 'valid', pattern_observed: 'p', principle: 'q', prevention_rule: 'r' },
      { pattern_observed: 'no rule_id', principle: 'x', prevention_rule: 'ok' },
    ];
    const result = parseLessonsResponse(JSON.stringify(mixed));
    expect(result).toHaveLength(1);
    expect(result[0].rule_id).toBe('valid');
  });

  it('filters out items missing prevention_rule', () => {
    const mixed = [
      { rule_id: 'valid', pattern_observed: 'p', principle: 'q', prevention_rule: 'r' },
      { rule_id: 'no_prevention', pattern_observed: 'x', principle: 'y' },
    ];
    const result = parseLessonsResponse(JSON.stringify(mixed));
    expect(result).toHaveLength(1);
  });

  it('throws on non-array JSON object', () => {
    expect(() => parseLessonsResponse('{"not": "an array"}')).toThrow();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseLessonsResponse('not json at all')).toThrow();
  });
});

// ── 3. shouldExtract — threshold guard ────────────────────────────────────────

describe('shouldExtract', () => {
  it('returns false for 0 snapshots', () => expect(shouldExtract(0)).toBe(false));
  it('returns false for 4 snapshots', () => expect(shouldExtract(4)).toBe(false));
  it('returns true at exactly 5 (MIN_SNAPSHOTS)', () => expect(shouldExtract(5)).toBe(true));
  it('returns true for 10 snapshots', () => expect(shouldExtract(10)).toBe(true));
  it('returns true for 50 snapshots', () => expect(shouldExtract(50)).toBe(true));
});

// ── 4. buildLessonInsert — correct shape for context_snapshots ────────────────

describe('buildLessonInsert', () => {
  const lesson: ExtractedLesson = {
    rule_id: 'test_rule',
    pattern_observed: 'Repeated mistake X',
    principle: 'Defense in depth',
    prevention_rule: 'Always check Y before Z',
  };

  it('produces snapshot_type=lesson', () => {
    const row = buildLessonInsert(lesson, 10);
    expect(row.snapshot_type).toBe('lesson');
  });

  it('content.rule includes rule_id and date', () => {
    const row = buildLessonInsert(lesson, 10);
    expect(row.content.rule).toMatch(/^auto_lesson_test_rule_\d{8}$/);
  });

  it('content preserves all lesson fields', () => {
    const row = buildLessonInsert(lesson, 7);
    expect(row.content.rule_id).toBe('test_rule');
    expect(row.content.pattern_observed).toBe('Repeated mistake X');
    expect(row.content.principle).toBe('Defense in depth');
    expect(row.content.prevention_rule).toBe('Always check Y before Z');
    expect(row.content.snapshots_analyzed).toBe(7);
  });

  it('content.source = weekly_auto_extraction', () => {
    const row = buildLessonInsert(lesson, 10);
    expect(row.content.source).toBe('weekly_auto_extraction');
  });

  it('generates correct rows for 10 mock gotchas (full pipeline sim)', () => {
    const snapshots = make10Gotchas();
    expect(shouldExtract(snapshots.length)).toBe(true);

    const mockLessons: ExtractedLesson[] = [
      { rule_id: 'validate_pre_call', pattern_observed: 'Missing checks before external calls', principle: 'Fail fast', prevention_rule: 'Validate inputs at API boundary' },
      { rule_id: 'log_counts_not_content', pattern_observed: 'Sensitive data logged', principle: 'Privacy', prevention_rule: 'Log counts and types only, never full content' },
    ];

    const rows = mockLessons.map((l) => buildLessonInsert(l, snapshots.length));
    expect(rows).toHaveLength(2);
    expect(rows[0].content.snapshots_analyzed).toBe(10);
    expect(rows[0].snapshot_type).toBe('lesson');
    expect(rows[1].content.rule).toMatch(/^auto_lesson_log_counts_not_content_/);
  });
});
