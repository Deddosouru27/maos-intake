import Anthropic from '@anthropic-ai/sdk';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { computeQualityScore, ScoredItem } from './score';
import { runVariant } from './variants';

const MAX_ITEMS = 50;
const SAMPLE_COUNT = 5;

export interface AutoResearchResult {
  status: 'completed' | 'skipped' | 'error';
  winner?: 'A' | 'B';
  score_a?: number;
  score_b?: number;
  samples_count?: number;
  reason?: string;
  error?: string;
}

interface KnowledgeRow {
  id: string;
  content: string;
  knowledge_type: string | null;
  tags: string[] | null;
  immediate_relevance: number | null;
  business_value: string | null;
  entity_objects: { name: string; type: string }[] | null;
}

export function buildSampleHash(itemIds: string[]): string {
  return createHash('sha256').update([...itemIds].sort().join(',')).digest('hex').slice(0, 16);
}

export function toScoredItem(row: KnowledgeRow): ScoredItem {
  return {
    knowledge_type: row.knowledge_type ?? 'insight',
    content: row.content,
    immediate_relevance: row.immediate_relevance ?? 0.4,
    tags: row.tags ?? [],
    entity_objects: row.entity_objects ?? [],
    business_value: row.business_value,
  };
}

export function buildResultInsert(
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

export function buildArchiveInsert(
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

export async function runAutoResearch(options?: {
  supabase?: SupabaseClient;
  anthropic?: Anthropic;
}): Promise<AutoResearchResult> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!pitstopUrl || !pitstopKey) return { status: 'error', error: 'PITSTOP env not set' };
  if (!anthropicKey && !options?.anthropic) return { status: 'error', error: 'ANTHROPIC_API_KEY not set' };

  const supabase = options?.supabase ?? createClient(pitstopUrl, pitstopKey);
  const client = options?.anthropic ?? new Anthropic({ apiKey: anthropicKey, maxRetries: 1 });

  // 1. Fetch fresh knowledge items
  const { data, error: fetchErr } = await supabase
    .from('extracted_knowledge')
    .select('id, content, knowledge_type, tags, immediate_relevance, business_value, entity_objects')
    .order('created_at', { ascending: false })
    .limit(MAX_ITEMS);

  if (fetchErr) return { status: 'error', error: `DB fetch: ${fetchErr.message}` };

  const rows = (data ?? []) as KnowledgeRow[];
  console.log(`[auto-research] Fetched ${rows.length} knowledge items`);

  if (rows.length < SAMPLE_COUNT) {
    return { status: 'skipped', reason: `only_${rows.length}_items`, samples_count: rows.length };
  }

  // 2. Select sample and compute dedup hash
  const samples = rows.slice(0, SAMPLE_COUNT);
  const sampleHash = buildSampleHash(samples.map((r) => r.id));
  const sampleTexts = samples.map((r) => r.content.slice(0, 500));

  // 3. Dedup: skip if already ran on the same samples
  const { data: existing, error: existErr } = await supabase
    .from('context_snapshots')
    .select('id')
    .eq('snapshot_type', 'prompt_optimization_result')
    .filter('content->>sample_hash', 'eq', sampleHash)
    .limit(1);

  if (existErr) {
    console.warn('[auto-research] dedup check failed:', existErr.message);
  } else if ((existing ?? []).length > 0) {
    console.log('[auto-research] Skipping — already ran on these samples');
    return { status: 'skipped', reason: 'already_ran_on_same_samples', samples_count: samples.length };
  }

  // 4. Run both variants
  let resultA: Awaited<ReturnType<typeof runVariant>>;
  try {
    console.log('[auto-research] Running variant A...');
    resultA = await runVariant('A', sampleTexts, client);
    console.log(`[auto-research] A: ${resultA.items.length} items, $${resultA.cost_usd.toFixed(5)}`);
  } catch (e) {
    return { status: 'error', error: `Variant A failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  let resultB: Awaited<ReturnType<typeof runVariant>>;
  try {
    console.log('[auto-research] Running variant B...');
    resultB = await runVariant('B', sampleTexts, client);
    console.log(`[auto-research] B: ${resultB.items.length} items, $${resultB.cost_usd.toFixed(5)}`);
  } catch (e) {
    return { status: 'error', error: `Variant B failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 5. Score and determine winner
  const qualityA = computeQualityScore(resultA.items);
  const qualityB = computeQualityScore(resultB.items);
  console.log(`[auto-research] Score A=${qualityA.score} B=${qualityB.score}`);

  const winner: 'A' | 'B' = qualityA.score >= qualityB.score ? 'A' : 'B';
  const loser: 'A' | 'B' = winner === 'A' ? 'B' : 'A';
  const loserScore = loser === 'A' ? qualityA.score : qualityB.score;

  // 6. Write winner result
  const winnerInsert = buildResultInsert(winner, qualityA.score, qualityB.score, samples.length, sampleHash);
  const { error: winErr } = await supabase.from('context_snapshots').insert(winnerInsert);
  if (winErr) {
    console.error('[auto-research] Winner insert failed:', winErr.message);
    return { status: 'error', error: `Winner insert failed: ${winErr.message}` };
  }

  // 7. Archive loser (non-fatal)
  const loserInsert = buildArchiveInsert(loser, loserScore, samples.length, sampleHash);
  const { error: loseErr } = await supabase.from('context_snapshots').insert(loserInsert);
  if (loseErr) {
    console.warn('[auto-research] Loser archive insert failed (non-fatal):', loseErr.message);
  }

  console.log(`[auto-research] Done. Winner: ${winner} (A=${qualityA.score} B=${qualityB.score})`);
  return {
    status: 'completed',
    winner,
    score_a: qualityA.score,
    score_b: qualityB.score,
    samples_count: samples.length,
  };
}
