import { createClient } from '@supabase/supabase-js';
import { ContentAnalysis } from '../types';

function getClient() {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP_SUPABASE_URL or PITSTOP_SUPABASE_ANON_KEY not set');
  return createClient(url, key);
}

function toRelevance(score: number): 'hot' | 'interesting' | 'noise' {
  if (score > 0.7) return 'hot';
  if (score > 0.3) return 'interesting';
  return 'noise';
}

export async function saveToPitstop(
  analysis: ContentAnalysis,
  sourceType: string,
  sourceUrl?: string,
): Promise<void> {
  if (analysis.relevance_score < 0.3) {
    console.log('[pitstop] skipping low relevance:', analysis.relevance_score);
    return;
  }
  if (analysis.ideas.length === 0) {
    console.log('[pitstop] skipping: no ideas extracted');
    return;
  }

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] client init failed:', err);
    return;
  }

  const row = {
    summary: analysis.summary.slice(0, 80),
    content: analysis.summary,
    extracted_ideas: analysis.ideas,
    source_type: sourceType,
    source_url: sourceUrl ?? null,
    ai_category: analysis.category,
    relevance: toRelevance(analysis.relevance_score),
    ai_analysis: analysis,
    status: 'new',
    project_id: null,
  };

  const { error } = await supabase.from('ideas').insert(row);

  if (error) {
    console.error('[pitstop] INSERT failed:', error.message);
  } else {
    console.log(`[pitstop] saved analysis from ${sourceType} (relevance: ${row.relevance})`);
  }
}
