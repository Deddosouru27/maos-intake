import Anthropic from '@anthropic-ai/sdk';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const ANALYSIS_MODEL = 'claude-sonnet-4-6';
const MIN_SNAPSHOTS = 5;
const MAX_SNAPSHOTS = 50;

export interface RawSnapshot {
  id: string;
  snapshot_type: string;
  content: Record<string, unknown>;
  created_at: string;
}

export interface ExtractedLesson {
  rule_id: string;
  pattern_observed: string;
  principle: string;
  prevention_rule: string;
}

export interface LessonsResult {
  status: 'extracted' | 'skipped' | 'error';
  snapshots_analyzed?: number;
  lessons_count?: number;
  lessons?: ExtractedLesson[];
  reason?: string;
  error?: string;
}

/**
 * Build the LLM prompt from snapshots.
 * Only uses structured metadata fields — never logs full content (may contain sensitive context).
 */
export function buildLessonsPrompt(snapshots: RawSnapshot[]): string {
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

/**
 * Parse raw LLM response into ExtractedLesson array.
 */
export function parseLessonsResponse(raw: string): ExtractedLesson[] {
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

export async function extractWeeklyLessons(
  _options?: { supabase?: SupabaseClient },
): Promise<LessonsResult> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!pitstopUrl || !pitstopKey) return { status: 'error', error: 'PITSTOP env not set' };
  if (!anthropicKey) return { status: 'error', error: 'ANTHROPIC_API_KEY not set' };

  const supabase = _options?.supabase ?? createClient(pitstopUrl, pitstopKey);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error: fetchErr } = await supabase
    .from('context_snapshots')
    .select('id, snapshot_type, content, created_at')
    .in('snapshot_type', ['gotcha', 'finding'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_SNAPSHOTS);

  if (fetchErr) return { status: 'error', error: `DB fetch: ${fetchErr.message}` };

  const snapshots = (data ?? []) as RawSnapshot[];
  console.log(`[lessons] Found ${snapshots.length} gotcha/finding snapshots in past 7 days`);

  if (snapshots.length < MIN_SNAPSHOTS) {
    console.log(`[lessons] Skipping — need ≥${MIN_SNAPSHOTS}, got ${snapshots.length}`);
    return { status: 'skipped', reason: `only_${snapshots.length}_snapshots`, snapshots_analyzed: snapshots.length };
  }

  const userPrompt = buildLessonsPrompt(snapshots);
  console.log(`[lessons] Calling ${ANALYSIS_MODEL} for ${snapshots.length} snapshots`);

  const client = new Anthropic({ apiKey: anthropicKey, maxRetries: 1 });
  let raw = '';
  try {
    const response = await client.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 2048,
      system: 'You are a learning system that extracts universal principles from repeated mistakes. Respond only with the JSON array requested. No preamble, no explanation.',
      messages: [{ role: 'user', content: userPrompt }],
    });
    raw = response.content[0].type === 'text' ? response.content[0].text : '';
    const usage = response.usage;
    // Sonnet 4.6 pricing: $3.00/MTok input, $15.00/MTok output
    const cost = (usage.input_tokens * 3.0 + usage.output_tokens * 15.0) / 1_000_000;
    console.log(`[lessons] ${ANALYSIS_MODEL} cost: $${cost.toFixed(5)} (in:${usage.input_tokens} out:${usage.output_tokens})`);
    // Lazy import to avoid pitstop module-level OpenAI client init in test env
    import('./pitstop').then(({ logLlmCost }) => {
      logLlmCost({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: cost, source: 'lessons_extractor', model: 'sonnet' }).catch(() => {});
    }).catch(() => {});
  } catch (llmErr) {
    const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
    console.error('[lessons] LLM call failed:', msg);
    return { status: 'error', error: `LLM failed: ${msg}` };
  }

  let lessons: ExtractedLesson[];
  try {
    lessons = parseLessonsResponse(raw);
  } catch (parseErr) {
    console.error('[lessons] JSON parse failed, raw (first 300):', raw.slice(0, 300));
    return { status: 'error', error: 'Failed to parse LLM response as JSON array' };
  }

  if (lessons.length === 0) {
    console.warn('[lessons] LLM returned 0 valid lessons');
    return { status: 'skipped', reason: 'zero_lessons_extracted', snapshots_analyzed: snapshots.length };
  }

  console.log(`[lessons] Extracted ${lessons.length} lessons — inserting to context_snapshots`);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const inserts = lessons.map((lesson) => ({
    snapshot_type: 'lesson',
    content: {
      type: 'lesson',
      rule: `auto_lesson_${lesson.rule_id}_${date}`,
      rule_id: lesson.rule_id,
      pattern_observed: lesson.pattern_observed,
      principle: lesson.principle,
      prevention_rule: lesson.prevention_rule,
      source: 'weekly_auto_extraction',
      date: new Date().toISOString(),
      snapshots_analyzed: snapshots.length,
    },
  }));

  const { error: insertErr } = await supabase.from('context_snapshots').insert(inserts);
  if (insertErr) {
    console.error('[lessons] Insert failed:', insertErr.message);
    return { status: 'error', error: `Insert failed: ${insertErr.message}` };
  }

  console.log(`[lessons] Saved ${lessons.length} lessons`);
  return { status: 'extracted', snapshots_analyzed: snapshots.length, lessons_count: lessons.length, lessons };
}
