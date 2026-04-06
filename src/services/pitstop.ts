import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem, EntityObject } from '../types';

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Similarity-based CRUD decision — replaces Haiku call (saves ~$0.00002/item, same quality)
// sim >= 0.95: texts are near-identical variants → UPDATE (new supersedes old)
// sim 0.75-0.94: related but distinct → ADD (keep both)
function crudDecisionFromSimilarity(similarity: number): 'ADD' | 'UPDATE' {
  return similarity >= 0.95 ? 'UPDATE' : 'ADD';
}

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

// Check if source_url already exists in ingested_content (any terminal or in-progress status)
export async function checkSourceUrlDedup(
  sourceUrl: string,
): Promise<{ exists: boolean; status?: string; id?: string }> {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('[dedup] PITSTOP env not set — skipping source_url dedup');
    return { exists: false };
  }

  let supabase;
  try {
    supabase = createClient(url, key);
  } catch (err) {
    console.error('[dedup] client init failed:', err);
    return { exists: false };
  }

  const { data, error } = await supabase
    .from('ingested_content')
    .select('id, processing_status')
    .eq('source_url', sourceUrl)
    .in('processing_status', ['done', 'processing', 'quarantined'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[dedup] source_url check error:', error.message);
    return { exists: false };
  }

  if (data && data.length > 0) {
    const row = data[0] as { id: string; processing_status: string };
    console.log(`[dedup] source_url HIT — status: ${row.processing_status}, id: ${row.id}`);
    return { exists: true, status: row.processing_status, id: row.id };
  }

  return { exists: false };
}

// Check if content_hash already exists in ingested_content (catches same content from different URLs)
export async function checkContentHashDedup(
  contentHash: string,
): Promise<{ exists: boolean; status?: string; id?: string; sourceUrl?: string }> {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('[dedup] PITSTOP env not set — skipping content_hash dedup');
    return { exists: false };
  }

  let supabase;
  try {
    supabase = createClient(url, key);
  } catch (err) {
    console.error('[dedup] client init failed:', err);
    return { exists: false };
  }

  const { data, error } = await supabase
    .from('ingested_content')
    .select('id, processing_status, source_url')
    .eq('content_hash', contentHash)
    .in('processing_status', ['done', 'processing', 'quarantined'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[dedup] content_hash check error:', error.message);
    return { exists: false };
  }

  if (data && data.length > 0) {
    const row = data[0] as { id: string; processing_status: string; source_url: string };
    console.log(`[dedup] content_hash HIT — status: ${row.processing_status}, id: ${row.id}, original_url: ${row.source_url}`);
    return { exists: true, status: row.processing_status, id: row.id, sourceUrl: row.source_url };
  }

  return { exists: false };
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

// QUARANTINE — set quarantined=true + quarantine_reason on ingested_content
export async function quarantineIngestedItem(
  id: string,
  reason: 'low_score' | 'high_score' | 'empty_entities' | string,
): Promise<void> {
  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] quarantine client init failed:', err);
    return;
  }

  const { error } = await supabase
    .from('ingested_content')
    .update({
      quarantined: true,
      quarantine_reason: reason,
      processing_status: 'quarantined',
    })
    .eq('id', id);

  if (error) {
    console.error('[INTAKE] IC QUARANTINE ERROR:', JSON.stringify(error));
  } else {
    console.warn(`[QUARANTINE] ingested_content ${id} quarantined: ${reason}`);
  }
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
): Promise<{ saved: { id: string; content: string }[]; dedupSkipped: number; smartCrudUpdates: number }> {
  if (items.length === 0) return { saved: [], dedupSkipped: 0, smartCrudUpdates: 0 };

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[pitstop] knowledge client init failed:', err);
    return { saved: [], dedupSkipped: 0, smartCrudUpdates: 0 };
  }

  console.log('[SAVE] Items count:', items?.length);
  console.log('[SAVE] Items to save:', JSON.stringify(items?.map((i) => i.content?.slice(0, 50))));

  const saved: { id: string; content: string }[] = [];
  let dedupSkipped = 0;
  let smartCrudUpdates = 0;
  const hasEmbedding = !!process.env.OPENAI_API_KEY;

  type SimilarRow = { id: string; content: string; similarity: number };

  for (const item of items) {
    const embedding = hasEmbedding ? await getEmbedding(item.content) : null;

    // Default action when no embedding available
    let action: 'ADD' | 'UPDATE' | 'NONE' = 'ADD';
    let existingRow: SimilarRow | null = null;

    if (hasEmbedding && !embedding) {
      console.warn(`[SMART_CRUD] ⚠️ embedding generation failed for: ${item.content.slice(0, 60)}`);
    }
    console.log(`[SMART_CRUD] New: ${item.content.slice(0, 80)}`);

    if (embedding) {
      const { data: similar } = await supabase.rpc('match_knowledge', {
        query_embedding: embedding,
        match_count: 3,
        similarity_threshold: 0.75,
      });
      const matches = (similar ?? []) as SimilarRow[];
      const top = matches.length > 0 ? matches[0] : null;
      console.log(`[SMART_CRUD] Best match sim: ${top ? top.similarity.toFixed(3) : 'none'}`);

      if (top) {
        if (top.similarity >= 0.97) {
          action = 'NONE';
        } else {
          existingRow = top;
          action = crudDecisionFromSimilarity(top.similarity);
        }
      }
    }

    console.log(`[SMART_CRUD] Decision: ${action}`);

    if (action === 'NONE') {
      dedupSkipped++;
      continue;
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
      entities: item.tags.length > 0 ? item.tags : null,
      entity_objects: item.entity_objects && item.entity_objects.length > 0 ? item.entity_objects : null,
      routed_to: [item.routed_to],
      language: null,
      source_url: sourceUrl,
      source_type: sourceType,
    };

    if (action === 'UPDATE' && existingRow) {
      // Insert new record, mark old as superseded
      const { data: insertedData, error: insertErr } = await supabase
        .from('extracted_knowledge')
        .insert({ ...row, event_type: 'UPDATE' })
        .select('id, content')
        .single();

      if (insertErr || !insertedData) {
        console.error('[CRUD] UPDATE insert failed:', insertErr?.message);
        continue;
      }

      const newRow = insertedData as { id: string; content: string };
      saved.push(newRow);
      smartCrudUpdates++;

      // Mark old as superseded
      await supabase
        .from('extracted_knowledge')
        .update({ superseded_by: newRow.id, event_type: 'SUPERSEDED' })
        .eq('id', existingRow.id);

      // memory_history
      await supabase.from('memory_history').insert({
        knowledge_id: newRow.id,
        prev_value: existingRow.content,
        new_value: item.content,
        action: 'UPDATE',
        reason: 'Haiku decided update',
      }).then(({ error: hErr }) => {
        if (hErr) console.error('[CRUD] memory_history UPDATE error:', hErr.message);
      });

      if (embedding) {
        const { error: embErr } = await supabase.from('extracted_knowledge').update({ embedding }).eq('id', newRow.id);
        if (embErr) console.warn(`[SMART_CRUD] ⚠️ embedding update failed for ID ${newRow.id}:`, embErr.message);
        else console.log(`[SMART_CRUD] ✅ embedding generated for knowledge ID ${newRow.id}`);
      }
    } else {
      // ADD
      const { data, error } = await supabase
        .from('extracted_knowledge')
        .insert({ ...row, event_type: 'ADD' })
        .select('id, content')
        .single();

      if (error || !data) {
        console.error('[INTAKE] extracted_knowledge INSERT error:', error?.message);
        continue;
      }

      const inserted = data as { id: string; content: string };
      saved.push(inserted);

      // memory_history
      await supabase.from('memory_history').insert({
        knowledge_id: inserted.id,
        prev_value: null,
        new_value: item.content,
        action: 'ADD',
        reason: 'new knowledge',
      }).then(({ error: hErr }) => {
        if (hErr) console.error('[CRUD] memory_history ADD error:', hErr.message);
      });

      if (embedding) {
        const { error: embErr } = await supabase.from('extracted_knowledge').update({ embedding }).eq('id', inserted.id);
        if (embErr) console.warn(`[SMART_CRUD] ⚠️ embedding update failed for ID ${inserted.id}:`, embErr.message);
        else console.log(`[SMART_CRUD] ✅ embedding generated for knowledge ID ${inserted.id}`);
      }
    }
  }

  console.log(`[INTAKE] extracted_knowledge: ${saved.length} saved, ${dedupSkipped} skipped, ${smartCrudUpdates} updated`);
  return { saved, dedupSkipped, smartCrudUpdates };
}

// Upsert entity_nodes and entity_edges for graph population
export async function upsertEntityGraph(
  entityObjects: EntityObject[],
): Promise<void> {
  if (!entityObjects || entityObjects.length === 0) return;

  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL ?? process.env.SUPABASE_PITSTOP_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY ?? process.env.SUPABASE_PITSTOP_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) return;

  const supabase = createClient(pitstopUrl, pitstopKey);

  // Deduplicate by lowercase name, keep first occurrence (preserves type)
  const seen = new Set<string>();
  const unique: EntityObject[] = [];
  for (const e of entityObjects) {
    const key = e.name.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }
  if (unique.length === 0) return;

  const names = unique.map(e => e.name);

  // Fetch existing nodes in one query
  const { data: existing } = await supabase
    .from('entity_nodes')
    .select('id, name, mention_count')
    .in('name', names);

  const existingByName = new Map(
    (existing ?? []).map(n => [n.name as string, n as { id: string; mention_count: number }])
  );

  const toInsert = unique.filter(e => !existingByName.has(e.name));
  const toUpdate = unique.filter(e => existingByName.has(e.name));

  // name → id map for edge building
  const nodeIdMap = new Map<string, string>();

  // Insert new nodes
  if (toInsert.length > 0) {
    const { data: inserted, error: insertErr } = await supabase
      .from('entity_nodes')
      .insert(toInsert.map(e => ({ name: e.name, type: e.type, mention_count: 1 })))
      .select('id, name');
    if (insertErr) {
      console.error('[entity_graph] insert nodes error:', insertErr.message);
    }
    for (const n of inserted ?? []) {
      nodeIdMap.set(n.name as string, n.id as string);
    }
  }

  // Increment mention_count for existing nodes
  for (const e of toUpdate) {
    const node = existingByName.get(e.name);
    if (!node) continue;
    nodeIdMap.set(e.name, node.id);
    await supabase
      .from('entity_nodes')
      .update({ mention_count: (node.mention_count ?? 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', node.id);
  }

  // Build co-occurrence edges for all unique pairs
  const nodeIds = [...nodeIdMap.values()];
  if (nodeIds.length < 2) return;

  const edgeRows: { source_id: string; target_id: string; relationship: string; weight: number }[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      edgeRows.push({
        source_id: nodeIds[i],
        target_id: nodeIds[j],
        relationship: 'co_occurs',
        weight: 1,
      });
    }
  }

  if (edgeRows.length > 0) {
    const { error: edgeErr } = await supabase
      .from('entity_edges')
      .upsert(edgeRows, { onConflict: 'source_id,target_id,relationship', ignoreDuplicates: true });
    if (edgeErr) {
      console.error('[entity_graph] upsert edges error:', edgeErr.message);
    }
  }

  console.log(`[entity_graph] upserted ${toInsert.length} new nodes, updated ${toUpdate.length}, ${edgeRows.length} edges`);
}

export async function saveToPitstop(
  analysis: BrainAnalysis,
  hotItems: KnowledgeItem[],
  sourceType: string,
  sourceUrl?: string,
  knowledgeSaved?: { id: string; content: string }[],
  strategicItems: KnowledgeItem[] = [],
): Promise<void> {
  const allItems = [
    ...hotItems.map(i => ({ item: i, relevance: 'hot' as const })),
    ...strategicItems.map(i => ({ item: i, relevance: 'strategic' as const })),
  ];

  if (allItems.length === 0) {
    console.log('[pitstop] no items to save to ideas');
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

  const rows = allItems.map(({ item, relevance }) => ({
    content: item.content,
    summary: item.content.slice(0, 80),
    ai_category: item.knowledge_type,
    source_type: sourceType,
    source_url: sourceUrl ?? null,
    relevance,
    ai_analysis: analysis,
    status: 'new',
    project_id: null,
    knowledge_id: knowledgeMap.get(item.content) ?? null,
  }));

  const { error } = await supabase.from('ideas').insert(rows);

  if (error) {
    console.error('[pitstop] ideas INSERT failed:', JSON.stringify(error));
  } else {
    console.log(`[pitstop] saved ${hotItems.length} hot + ${strategicItems.length} strategic ideas from ${sourceType}`);
  }
}
