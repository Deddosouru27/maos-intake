import { createClient } from '@supabase/supabase-js';
import { ContentAnalysis } from '../types';

function getClient() {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP_SUPABASE_URL or PITSTOP_SUPABASE_ANON_KEY not set');
  return createClient(url, key);
}

export async function saveToPitstop(
  analysis: ContentAnalysis,
  sourceType: string,
): Promise<void> {
  if (analysis.ideas.length === 0) return;

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] client init failed:', err);
    return;
  }

  const rows = analysis.ideas.map((idea) => ({
    content: idea,
    category: analysis.category,
    source: sourceType,
    project_id: null,
  }));

  const { error } = await supabase.from('ideas').insert(rows);

  if (error) {
    console.error('[pitstop] INSERT failed:', error.message);
  } else {
    console.log(`[pitstop] saved ${rows.length} ideas from ${sourceType}`);
  }
}
