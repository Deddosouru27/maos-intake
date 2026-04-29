/**
 * Trend detection via entity frequency spike analysis.
 *
 * RESEARCH FINDING (gemini_deep_research_eval_30apr):
 *   Gemini Deep Research API evaluated → verdict: not_usable
 *   - Deep Research: $1–7/call, 15–60 min async — unacceptable latency
 *   - Grounding: $0.014–0.035/call, 1500/day limit, no date range control
 *   - Neither exposes confidence scores
 *   - 7–2000x more expensive than current pipeline
 *   → Chosen alternative: entity frequency spike detection (zero API cost, <100ms)
 *
 * Algorithm:
 *   1. Fetch extracted_knowledge from last (RECENT_DAYS + BASELINE_DAYS) = 10 days
 *   2. For each entity: count mentions in recent 3 days vs baseline 7 days
 *   3. Spike = recent_avg_per_day > 2x baseline_avg_per_day AND recent >= MIN_MENTIONS
 *   4. Top MAX_TOP_ENTITIES by recent mentions analyzed (cost/performance guard)
 *   5. Write trend_signal snapshots + research_finding snapshot (idempotent)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const RECENT_DAYS = 3;
export const BASELINE_DAYS = 7;
export const SPIKE_RATIO_THRESHOLD = 2.0;
export const MAX_TOP_ENTITIES = 20;
export const MIN_RECENT_MENTIONS = 2;

export interface KnowledgeRow {
  id: string;
  entity_objects: { name: string; type: string }[] | null;
  source_type: string | null;
  created_at: string;
}

export interface EntityMentionData {
  entity_type: string;
  recent: number;
  baseline: number;
}

export interface TrendSignal {
  entity: string;
  entity_type: string;
  mentions_recent: number;
  mentions_baseline: number;
  spike_ratio: number;
  confidence: 'high' | 'medium' | 'low';
  window_days: number;
  generated_at: string;
}

export interface DetectTrendsResult {
  status: 'completed' | 'skipped' | 'error';
  entities_analyzed: number;
  trends_found: number;
  signals: TrendSignal[];
  research_finding_written: boolean;
  error?: string;
}

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Split entity mentions from rows into recent vs baseline buckets.
 * recent = last recentDays, baseline = the baselineDays before that.
 */
export function computeEntityMentions(
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
      const name = entity.name;
      const entry = entityMap.get(name) ?? { entity_type: entity.type, recent: 0, baseline: 0 };
      if (isRecent) entry.recent++;
      else entry.baseline++;
      entityMap.set(name, entry);
    }
  }

  return entityMap;
}

/**
 * Detect if an entity has a frequency spike.
 * Cost/noise guard: MIN_RECENT_MENTIONS prevents false positives from 0→1 moves.
 * Removing this guard causes 1-mention entities to appear as infinite-ratio spikes.
 */
export function detectSpike(
  recentMentions: number,
  baselineMentions: number,
  recentDays: number,
  baselineDays: number,
): { is_spike: boolean; ratio: number } {
  if (recentMentions < MIN_RECENT_MENTIONS) return { is_spike: false, ratio: 0 };

  const recentPerDay = recentMentions / recentDays;
  const baselinePerDay = baselineDays > 0 ? baselineMentions / baselineDays : 0;

  if (baselinePerDay === 0) {
    // New entity (no baseline): spike only if recent activity is meaningful
    const is_spike = recentMentions >= MIN_RECENT_MENTIONS * 2;
    return { is_spike, ratio: is_spike ? 999 : 0 };
  }

  const ratio = parseFloat((recentPerDay / baselinePerDay).toFixed(2));
  return { is_spike: ratio >= SPIKE_RATIO_THRESHOLD, ratio };
}

/**
 * Confidence rating from spike ratio.
 * Removing this causes 'high' to never be returned — structure test fails.
 */
export function spikeConfidence(ratio: number): 'high' | 'medium' | 'low' {
  if (ratio >= 5) return 'high';
  if (ratio >= SPIKE_RATIO_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Return top N entities ordered by recent mention count (cost guard: limits analysis scope).
 * Removing MAX_TOP_ENTITIES guard causes runTrendDetection to analyze unbounded entity set.
 */
export function topEntitiesByRecent(
  mentions: Map<string, EntityMentionData>,
  limit = MAX_TOP_ENTITIES,
): [string, EntityMentionData][] {
  return Array.from(mentions.entries())
    .sort((a, b) => b[1].recent - a[1].recent)
    .slice(0, limit);
}

// ── Research finding (idempotent write) ───────────────────────────────────────

const RESEARCH_RULE = 'gemini_deep_research_eval_30apr';

export function buildResearchFinding() {
  return {
    snapshot_type: 'research_finding',
    content: {
      type: 'research_finding',
      rule: RESEARCH_RULE,
      verdict: 'not_usable',
      api_evaluated: 'Gemini Deep Research API + Grounding',
      cost_analysis: {
        deep_research_per_call_usd: '1–7',
        grounding_per_call_usd: '0.014–0.035',
        our_pipeline_cost_usd: '0.001–0.003',
        cost_multiplier: '7–2000x',
      },
      rate_limits: {
        grounding_per_day: 1500,
        deep_research: 'async polling, no documented RPM',
      },
      key_issues: [
        'Deep Research: 15–60 min async — unacceptable for trend detection pipeline',
        'Neither API exposes confidence scores or source reliability ranking',
        'Cannot control search date ranges — model decides what to search',
        'Grounding: 1500/day free limit hit quickly at production scale',
        'Cost 7–2000x more expensive than current Haiku+Jina pipeline',
      ],
      alternative_chosen: 'entity_frequency_spike_detection',
      alternative_description:
        'Count entity mentions per day from extracted_knowledge. ' +
        'Spike = recent 3-day avg > 2x previous 7-day avg AND recent >= 2. ' +
        'Zero API cost, <100ms latency, no external dependencies.',
      perplexity_noted: 'Perplexity API ($0.005/query) remains viable for future Cycle 6 deep search if needed.',
      date: new Date().toISOString(),
    },
  };
}

async function writeResearchFindingIfNeeded(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase
    .from('context_snapshots')
    .select('id')
    .eq('snapshot_type', 'research_finding')
    .filter('content->>rule', 'eq', RESEARCH_RULE)
    .limit(1);

  if ((data ?? []).length > 0) return false;

  const { error } = await supabase.from('context_snapshots').insert(buildResearchFinding());
  if (error) {
    console.warn('[trend-detection] research_finding write failed:', error.message);
    return false;
  }
  console.log(`[trend-detection] research_finding written: ${RESEARCH_RULE}`);
  return true;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runTrendDetection(options?: {
  supabase?: SupabaseClient;
  daysBack?: number;
}): Promise<DetectTrendsResult> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    return { status: 'error', entities_analyzed: 0, trends_found: 0, signals: [], research_finding_written: false, error: 'PITSTOP env not set' };
  }

  const supabase = options?.supabase ?? createClient(pitstopUrl, pitstopKey);

  // Write research finding once (idempotent)
  const research_finding_written = await writeResearchFindingIfNeeded(supabase);

  const totalDays = RECENT_DAYS + BASELINE_DAYS;
  const since = new Date(Date.now() - totalDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error: fetchErr } = await supabase
    .from('extracted_knowledge')
    .select('id, entity_objects, source_type, created_at')
    .gte('created_at', since)
    .not('entity_objects', 'is', null)
    .limit(2000);

  if (fetchErr) {
    return { status: 'error', entities_analyzed: 0, trends_found: 0, signals: [], research_finding_written, error: `DB fetch: ${fetchErr.message}` };
  }

  const rows = (data ?? []).filter(
    (r: { entity_objects: unknown }) => Array.isArray(r.entity_objects) && (r.entity_objects as unknown[]).length > 0,
  ) as KnowledgeRow[];

  console.log(`[trend-detection] Analyzing ${rows.length} rows with entities from last ${totalDays} days`);

  if (rows.length === 0) {
    return { status: 'skipped', entities_analyzed: 0, trends_found: 0, signals: [], research_finding_written };
  }

  // Compute entity mentions and apply cost guard
  const mentions = computeEntityMentions(rows);
  const topEntities = topEntitiesByRecent(mentions); // limited to MAX_TOP_ENTITIES

  const signals: TrendSignal[] = [];
  const now = new Date().toISOString();

  for (const [entity, { entity_type, recent, baseline }] of topEntities) {
    const { is_spike, ratio } = detectSpike(recent, baseline, RECENT_DAYS, BASELINE_DAYS);
    if (!is_spike) continue;

    const signal: TrendSignal = {
      entity,
      entity_type,
      mentions_recent: recent,
      mentions_baseline: baseline,
      spike_ratio: ratio,
      confidence: spikeConfidence(ratio),
      window_days: totalDays,
      generated_at: now,
    };
    signals.push(signal);

    const { error: snapErr } = await supabase.from('context_snapshots').insert({
      snapshot_type: 'trend_signal',
      content: { type: 'trend_signal', ...signal },
    });
    if (snapErr) {
      console.warn(`[trend-detection] trend_signal insert for "${entity}" failed:`, snapErr.message);
    }
  }

  console.log(`[trend-detection] Done. Entities analyzed: ${topEntities.length}, signals: ${signals.length}`);

  return {
    status: 'completed',
    entities_analyzed: topEntities.length,
    trends_found: signals.length,
    signals,
    research_finding_written,
  };
}
