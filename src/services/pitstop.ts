import { createClient } from '@supabase/supabase-js';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem } from '../types';

function getClient() {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP_SUPABASE_URL or PITSTOP_SUPABASE_ANON_KEY not set');
  return createClient(url, key);
}

export async function saveIngestedContent(
  rawText: string,
  sourceUrl: string,
  sourceType: string,
  title: string | undefined,
  contentHash: string,
): Promise<void> {
  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] ingest client init failed:', err);
    return;
  }

  const { error } = await supabase.from('ingested_content').insert({
    source_url: sourceUrl,
    source_type: sourceType,
    raw_text: rawText.slice(0, 50000),
    title: title ?? null,
    content_hash: contentHash,
  });

  if (error) {
    console.error('[pitstop] ingested_content INSERT failed:', error.message);
  } else {
    console.log(`[pitstop] ingested content saved: ${sourceUrl}`);
  }
}

export async function saveExtractedKnowledge(
  items: RoutedKnowledgeItem[],
  sourceUrl: string,
  sourceType: string,
): Promise<void> {
  if (items.length === 0) return;

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] knowledge client init failed:', err);
    return;
  }

  const rows = items.map((item) => ({
    content: item.content,
    knowledge_type: item.knowledge_type,
    project: item.project,
    domains: item.domains,
    solves_need: item.solves_need,
    immediate_relevance: item.immediate_relevance,
    strategic_relevance: item.strategic_relevance,
    novelty: item.novelty,
    effort: item.effort,
    has_ready_code: item.has_ready_code,
    tags: item.tags,
    routed_to: item.routed_to,
    source_url: sourceUrl,
    source_type: sourceType,
  }));

  const { error } = await supabase.from('extracted_knowledge').insert(rows);

  if (error) {
    console.error('[pitstop] extracted_knowledge INSERT failed:', error.message);
  } else {
    console.log(`[pitstop] saved ${items.length} knowledge items`);
  }
}

export async function saveToPitstop(
  analysis: BrainAnalysis,
  hotItems: KnowledgeItem[],
  sourceType: string,
  sourceUrl?: string,
): Promise<void> {
  if (hotItems.length === 0) {
    console.log('[pitstop] no hot items to save to ideas');
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
    extracted_ideas: hotItems,
    source_type: sourceType,
    source_url: sourceUrl ?? null,
    ai_category: analysis.category,
    relevance: 'hot',
    ai_analysis: analysis,
    status: 'new',
    project_id: null,
  };

  const { error } = await supabase.from('ideas').insert(row);

  if (error) {
    console.error('[pitstop] ideas INSERT failed:', error.message);
  } else {
    console.log(`[pitstop] saved hot ideas from ${sourceType} (${hotItems.length} items)`);
  }
}
