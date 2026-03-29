import { createClient } from '@supabase/supabase-js';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem } from '../types';

function getClient() {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP_SUPABASE_URL or PITSTOP_SUPABASE_ANON_KEY not set');
  return createClient(url, key);
}

// INSERT before analysis — ensures dedup works even if Haiku fails
export async function insertIngestedPending(
  rawText: string,
  sourceUrl: string,
  sourceType: string,
  title: string | undefined,
  contentHash: string,
): Promise<string | null> {
  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] ingest client init failed:', err);
    return null;
  }

  const insertData = {
    source_url: sourceUrl,
    source_type: sourceType || 'unknown',
    raw_text: rawText.slice(0, 50000),
    title: title ?? null,
    content_hash: contentHash,
    word_count: rawText.split(/\s+/).filter(Boolean).length,
    processing_status: 'processing',
  };

  const payload = {
    source_url: insertData.source_url,
    source_type: String(insertData.source_type),
    title: insertData.title?.substring(0, 30) ?? null,
    content_hash: insertData.content_hash,
    processing_status: insertData.processing_status,
  };
  console.log('[INTAKE] IC payload:', JSON.stringify(payload));

  let insertError;
  try {
    ({ error: insertError } = await supabase.from('ingested_content').insert(insertData));
  } catch (err) {
    console.error('[INTAKE] IC INSERT exception:', err instanceof Error ? err.message : String(err));
    return null;
  }

  if (insertError) {
    console.error('[INTAKE] IC INSERT FAIL:', JSON.stringify({
      message: insertError.message,
      code: insertError.code,
      details: insertError.details,
      hint: insertError.hint,
    }));
    return null;
  }

  console.log('[INTAKE] IC INSERT OK');

  const { data: row, error: selectError } = await supabase
    .from('ingested_content')
    .select('id')
    .eq('content_hash', contentHash)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (selectError) {
    console.warn('[INTAKE] IC SELECT id failed:', selectError.message);
    return null;
  }

  const id = (row as { id: string } | null)?.id ?? null;
  console.log('[INTAKE] ingested_content pending saved, id:', id);
  return id;
}

// UPDATE after analysis completes
export async function updateIngestedDone(
  id: string,
  analysis: BrainAnalysis,
  routingResult: string,
): Promise<void> {
  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] update client init failed:', err);
    return;
  }

  const { error } = await supabase
    .from('ingested_content')
    .update({
      processing_status: 'done',
      summary: analysis.summary,
      overall_immediate: analysis.overall_immediate,
      overall_strategic: analysis.overall_strategic,
      knowledge_count: analysis.knowledge_items.length,
      routing_result: routingResult,
      language: analysis.language,
    })
    .eq('id', id);

  if (error) {
    console.error('[INTAKE] IC UPDATE ERROR:', JSON.stringify(error));
  } else {
    console.log('[INTAKE] ingested_content updated to done, id:', id);
  }
}

export async function saveExtractedKnowledge(
  items: RoutedKnowledgeItem[],
  ingestedContentId: string | null,
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

  console.log('[INTAKE] Saving to extracted_knowledge:', { count: items.length });

  // Schema: ingested_content_id, content, knowledge_type, project_id (uuid|null),
  // domain_ids (uuid[]|null), solves_need, immediate_relevance, strategic_relevance,
  // novelty, effort, has_ready_code, routed_to (text[]), tags (text[]),
  // language, source_url, source_type
  const rows = items.map((item) => ({
    ingested_content_id: ingestedContentId,
    content: item.content,
    knowledge_type: item.knowledge_type,
    project_id: null,       // no uuid mapping yet
    domain_ids: null,       // no uuid mapping yet
    solves_need: item.solves_need,
    immediate_relevance: item.immediate_relevance,
    strategic_relevance: item.strategic_relevance,
    novelty: item.novelty,
    effort: item.effort,
    has_ready_code: item.has_ready_code,
    business_value: item.business_value ?? null,
    tags: item.tags,
    routed_to: [item.routed_to], // text[] — wrap single value in array
    language: null,
    source_url: sourceUrl,
    source_type: sourceType,
  }));

  const { data, error } = await supabase
    .from('extracted_knowledge')
    .insert(rows)
    .select('id');

  if (error) {
    console.error('[INTAKE] extracted_knowledge ERROR:', JSON.stringify(error));
  } else {
    console.log('[INTAKE] extracted_knowledge saved:', (data as { id: string }[] | null)?.length, 'items');
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
    console.error('[pitstop] ideas INSERT failed:', JSON.stringify(error));
  } else {
    console.log(`[pitstop] saved hot ideas from ${sourceType} (${hotItems.length} items)`);
  }
}
