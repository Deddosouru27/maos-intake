import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { computeItemQuality, ItemQualityInput } from './score';

const DEFAULT_DAYS = 7;
const FETCH_LIMIT = 1000;
const CALIBRATION_BROKEN_THRESHOLD = 0.8;
const TRASH_SCORE_THRESHOLD = 0.3;

export interface KnowledgeRow extends ItemQualityInput {
  id: string;
  source_url: string | null;
  source_type: string | null;
  immediate_relevance: number | null;
  created_at: string;
}

export interface SourceMetrics {
  source_type: string;
  count: number;
  avg_quality: number;
  pct_trash: number;
  pct_no_entities: number;
  pct_default_score: number;
}

export interface QualityEvalResult {
  status: 'completed' | 'skipped' | 'error';
  days: number;
  items_analyzed: number;
  avg_quality: number;
  pct_trash: number;
  pct_no_entities: number;
  pct_default_score: number;
  calibration_broken: boolean;
  by_source: SourceMetrics[];
  snapshot_type?: string;
  error?: string;
}

// ── Pure functions ────────────────────────────────────────────────────────────

/** True if the item's created_at falls within the last `days` days. */
export function isWithinDays(createdAt: string, days: number, now = Date.now()): boolean {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return new Date(createdAt).getTime() >= cutoff;
}

/** True if >80% of relevance scores are exactly 0.5 (default, uncalibrated). */
export function isCalibrationBroken(scores: number[]): boolean {
  if (scores.length === 0) return false;
  const defaultCount = scores.filter((s) => s === 0.5).length;
  return defaultCount / scores.length > CALIBRATION_BROKEN_THRESHOLD;
}

/** Group knowledge rows by source_type and compute per-source quality metrics. */
export function computeSourceMetrics(rows: KnowledgeRow[]): SourceMetrics[] {
  const groups = new Map<string, KnowledgeRow[]>();
  for (const row of rows) {
    const key = row.source_type ?? 'unknown';
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  return Array.from(groups.entries()).map(([source_type, items]) => {
    const qualities = items.map((i) => computeItemQuality(i).quality_score);
    const avg_quality =
      qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0;

    const count = items.length;
    const pct_trash =
      items.filter((i) => (i.immediate_relevance ?? 0.5) < TRASH_SCORE_THRESHOLD).length / count;
    const pct_no_entities =
      items.filter((i) => (i.entity_objects?.length ?? 0) === 0).length / count;
    const pct_default_score =
      items.filter((i) => (i.immediate_relevance ?? 0.5) === 0.5).length / count;

    return {
      source_type,
      count,
      avg_quality: parseFloat(avg_quality.toFixed(4)),
      pct_trash: parseFloat(pct_trash.toFixed(4)),
      pct_no_entities: parseFloat(pct_no_entities.toFixed(4)),
      pct_default_score: parseFloat(pct_default_score.toFixed(4)),
    };
  });
}

export function buildSnapshotContent(
  result: Omit<QualityEvalResult, 'status' | 'snapshot_type' | 'error'>,
  snapshotType: string,
) {
  return {
    snapshot_type: snapshotType,
    content: {
      type: snapshotType,
      ...result,
      generated_at: new Date().toISOString(),
    },
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runQualityEval(options?: {
  days?: number;
  supabase?: SupabaseClient;
}): Promise<QualityEvalResult> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    return { status: 'error', error: 'PITSTOP env not set', days: 0, items_analyzed: 0, avg_quality: 0, pct_trash: 0, pct_no_entities: 0, pct_default_score: 0, calibration_broken: false, by_source: [] };
  }

  const supabase = options?.supabase ?? createClient(pitstopUrl, pitstopKey);
  const days = options?.days ?? DEFAULT_DAYS;

  // 1. Fetch knowledge items from the last `days` days
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error: fetchErr } = await supabase
    .from('extracted_knowledge')
    .select('id, content, tags, entity_objects, business_value, immediate_relevance, source_url, source_type, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(FETCH_LIMIT);

  if (fetchErr) {
    return { status: 'error', error: `DB fetch: ${fetchErr.message}`, days, items_analyzed: 0, avg_quality: 0, pct_trash: 0, pct_no_entities: 0, pct_default_score: 0, calibration_broken: false, by_source: [] };
  }

  const rows = (data ?? []) as KnowledgeRow[];
  console.log(`[quality-eval] Fetched ${rows.length} items from last ${days} days`);

  if (rows.length === 0) {
    return { status: 'skipped', days, items_analyzed: 0, avg_quality: 0, pct_trash: 0, pct_no_entities: 0, pct_default_score: 0, calibration_broken: false, by_source: [] };
  }

  // 2. Score each item and compute aggregate metrics
  const qualities = rows.map((r) => computeItemQuality(r).quality_score);
  const relevanceScores = rows.map((r) => r.immediate_relevance ?? 0.5);

  const avg_quality = parseFloat((qualities.reduce((a, b) => a + b, 0) / qualities.length).toFixed(4));
  const pct_trash = parseFloat((rows.filter((r) => (r.immediate_relevance ?? 0.5) < TRASH_SCORE_THRESHOLD).length / rows.length).toFixed(4));
  const pct_no_entities = parseFloat((rows.filter((r) => (r.entity_objects?.length ?? 0) === 0).length / rows.length).toFixed(4));
  const pct_default_score = parseFloat((rows.filter((r) => (r.immediate_relevance ?? 0.5) === 0.5).length / rows.length).toFixed(4));
  const calibration_broken = isCalibrationBroken(relevanceScores);

  // 3. Group by source_type
  const by_source = computeSourceMetrics(rows);
  console.log(`[quality-eval] avg_quality=${avg_quality} trash=${(pct_trash * 100).toFixed(1)}% calibration_broken=${calibration_broken} sources=${by_source.length}`);

  // 4. Write quality_baseline snapshot
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const snapshotType = `quality_baseline_${dateStr}`;

  const evalResult = { days, items_analyzed: rows.length, avg_quality, pct_trash, pct_no_entities, pct_default_score, calibration_broken, by_source };
  const snapshotRow = buildSnapshotContent(evalResult, snapshotType);

  const { error: snapErr } = await supabase.from('context_snapshots').insert(snapshotRow);
  if (snapErr) {
    console.warn('[quality-eval] snapshot insert failed:', snapErr.message);
  } else {
    console.log(`[quality-eval] snapshot written: ${snapshotType}`);
  }

  // 5. Update source_quality_score on knowledge rows (via metadata column if exists)
  for (const source of by_source) {
    const sourceIds = rows
      .filter((r) => (r.source_type ?? 'unknown') === source.source_type)
      .map((r) => r.id);
    if (sourceIds.length === 0) continue;

    // Non-fatal: metadata column may not exist — warns and continues
    const { error: metaErr } = await supabase
      .from('extracted_knowledge')
      .update({ metadata: { source_quality_score: source.avg_quality } })
      .in('id', sourceIds);
    if (metaErr) {
      console.warn(`[quality-eval] metadata update for source ${source.source_type} failed (column may not exist):`, metaErr.message);
    }
  }

  return { status: 'completed', ...evalResult, snapshot_type: snapshotType };
}
