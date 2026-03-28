import { createClient } from '@supabase/supabase-js';
import { BrainAnalysis, KnowledgeItem } from '../types';

function getClient() {
  const url = process.env.MEMORY_SUPABASE_URL;
  const key = process.env.MEMORY_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('MEMORY_SUPABASE_URL or MEMORY_SUPABASE_ANON_KEY not set');
  return createClient(url, key);
}

export async function saveToMemory(
  analysis: BrainAnalysis,
  strategicItems: KnowledgeItem[],
  source: string,
  url?: string,
  sourceType?: string,
): Promise<void> {
  if (strategicItems.length === 0) {
    console.log('[memory] no strategic items to save');
    return;
  }

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[memory] client init failed:', err);
    return;
  }

  const allTags = [...new Set(strategicItems.flatMap((i) => i.tags))];

  const { error } = await supabase.from('memories').insert({
    content: analysis.summary,
    metadata: {
      source,
      url,
      knowledge_items: strategicItems,
      tags: allTags,
      overall_strategic: analysis.overall_strategic,
      language: analysis.language,
    },
    source: 'maos-intake',
    profile: 'artur',
    tags: ['intake', sourceType ?? 'unknown', ...allTags],
    importance: analysis.overall_strategic,
    confidence: 1.0,
    compression_level: 0,
    surprise: 0.0,
  });

  if (error) {
    console.error('[memory] INSERT failed:', error.message);
  } else {
    console.log(`[memory] saved to maos-memory: ${source} (${strategicItems.length} items)`);
  }
}
