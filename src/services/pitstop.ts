import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem } from '../types';

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await openaiClient.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000),
      dimensions: 512,
    });
    return resp.data[0].embedding;
  } catch (err) {
    console.error('[pitstop] embedding error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

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
  savedCount?: number,
  isGuide?: boolean,
  status?: string,
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
      processing_status: status ?? 'done',
      summary: analysis.summary,
      overall_immediate: analysis.overall_immediate,
      overall_strategic: analysis.overall_strategic,
      knowledge_count: savedCount ?? analysis.knowledge_items.length,
      routing_result: routingResult,
      language: analysis.language,
      haiku_raw_response: analysis,
      is_guide: isGuide ?? false,
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
): Promise<{ id: string; content: string }[]> {
  if (items.length === 0) return [];

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] knowledge client init failed:', err);
    return [];
  }

  console.log('[INTAKE] Saving to extracted_knowledge:', { count: items.length });

  const saved: { id: string; content: string }[] = [];
  let dedupSkipped = 0;

  for (const item of items) {
    // Get embedding first — needed for both dedup check and storage
    const embedding = await getEmbedding(item.content);

    // Semantic dedup: skip if a very similar item already exists (sim >= 0.9)
    if (embedding) {
      const { data: similar } = await supabase.rpc('match_knowledge', {
        query_embedding: embedding,
        match_count: 1,
        similarity_threshold: 0.97,
      });
      if (similar && (similar as { similarity: number }[]).length > 0) {
        const sim = (similar as { similarity: number }[])[0].similarity;
        console.log(`[DEDUP] Skipping duplicate: ${item.content.slice(0, 50)}... (sim: ${sim.toFixed(3)})`);
        dedupSkipped++;
        continue;
      }
    }

    const row = {
      ingested_content_id: ingestedContentId,
      content: item.content,
      knowledge_type: item.knowledge_type,
      project_id: null,
      domain_ids: null,
      solves_need: item.solves_need,
      immediate_relevance: item.immediate_relevance,
      strategic_relevance: item.strategic_relevance,
      novelty: item.novelty,
      effort: item.effort,
      has_ready_code: item.has_ready_code,
      business_value: item.business_value ?? null,
      tags: item.tags,
      routed_to: [item.routed_to],
      language: null,
      source_url: sourceUrl,
      source_type: sourceType,
    };

    const { data, error } = await supabase
      .from('extracted_knowledge')
      .insert(row)
      .select('id, content')
      .single();

    if (error) {
      console.error('[INTAKE] extracted_knowledge INSERT error:', JSON.stringify(error));
      continue;
    }

    const inserted = data as { id: string; content: string } | null;
    if (!inserted) continue;
    saved.push(inserted);

    // Store embedding
    if (embedding) {
      const { error: embErr } = await supabase
        .from('extracted_knowledge')
        .update({ embedding })
        .eq('id', inserted.id);
      if (embErr) {
        console.error('[pitstop] embedding update error for', inserted.id, embErr.message);
      }
    }
  }

  console.log(`[INTAKE] extracted_knowledge saved: ${saved.length} items, dedup skipped: ${dedupSkipped}`);
  return saved;
}

export async function saveToPitstop(
  analysis: BrainAnalysis,
  hotItems: KnowledgeItem[],
  sourceType: string,
  sourceUrl?: string,
  knowledgeSaved?: { id: string; content: string }[],
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

  // Build content→id map for knowledge_id linkage
  const knowledgeMap = new Map<string, string>();
  for (const k of (knowledgeSaved ?? [])) {
    knowledgeMap.set(k.content, k.id);
  }

  const rows = hotItems.map((item) => ({
    content: item.content,
    summary: item.content.slice(0, 80),
    ai_category: item.knowledge_type,
    source_type: sourceType,
    source_url: sourceUrl ?? null,
    relevance: 'hot',
    ai_analysis: analysis,
    status: 'new',
    project_id: null,
    knowledge_id: knowledgeMap.get(item.content) ?? null,
  }));

  const { error } = await supabase.from('ideas').insert(rows);

  if (error) {
    console.error('[pitstop] ideas INSERT failed:', JSON.stringify(error));
  } else {
    console.log(`[pitstop] saved ${hotItems.length} hot ideas from ${sourceType}`);
  }
}
