import { createClient } from '@supabase/supabase-js';
import { ContentAnalysis } from '../types';

function getClient() {
  const url = process.env.MEMORY_SUPABASE_URL;
  const key = process.env.MEMORY_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('MEMORY_SUPABASE_URL or MEMORY_SUPABASE_ANON_KEY not set');
  return createClient(url, key);
}

export async function saveToMemory(
  analysis: ContentAnalysis,
  source: string,
  url?: string,
  sourceType?: string,
): Promise<void> {
  if (analysis.relevance_score < 0.3) {
    console.log('[memory] skipping low relevance:', analysis.relevance_score);
    return;
  }
  if (analysis.ideas.length === 0) {
    console.log('[memory] skipping: no ideas extracted');
    return;
  }

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[memory] client init failed:', err);
    return;
  }

  const { error } = await supabase.from('memories').insert({
    content: analysis.summary,
    metadata: {
      source,
      url,
      ideas: analysis.ideas,
      tags: analysis.tags,
      relevance_score: analysis.relevance_score,
      language: analysis.language,
    },
    source: 'maos-intake',
    profile: 'artur',
    tags: ['intake', sourceType ?? 'unknown', ...analysis.tags],
    importance: analysis.relevance_score,
    confidence: 1.0,
    compression_level: 0,
    surprise: 0.0,
  });

  if (error) {
    console.error('[memory] INSERT failed:', error.message);
  } else {
    console.log(`[memory] saved to maos-memory: ${source}`);
  }
}
