import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem, EntityObject, EntityRelationship, EntityRelationshipType } from '../types';

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

  // Intra-batch Jaccard dedup: remove items too similar to an earlier item in the same batch
  function jaccardSimilar(a: string, b: string): boolean {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 && intersection / union > 0.6;
  }
  const dedupedItems: typeof items = [];
  for (const candidate of items) {
    const isDup = dedupedItems.some((kept) => jaccardSimilar(kept.content, candidate.content));
    if (isDup) {
      console.log('[SAVE] Intra-batch Jaccard dedup — skipping:', candidate.content.slice(0, 80));
      dedupSkipped++;
    } else {
      dedupedItems.push(candidate);
    }
  }
  const filteredItems = dedupedItems;

  type SimilarRow = { id: string; content: string; similarity: number };

  for (const item of filteredItems) {
    // Score threshold: skip low-relevance items before any DB call
    if ((item.immediate_relevance ?? 0) < 0.4) {
      console.log('[extraction] skipped low-score item:', item.content?.slice(0, 80), 'score:', item.immediate_relevance);
      dedupSkipped++;
      continue;
    }
    // Fast content-hash dedup — skip before expensive embedding call
    const contentHash = createHash('sha256').update(item.content).digest('hex');
    const { data: hashExisting } = await supabase
      .from('extracted_knowledge')
      .select('id')
      .eq('content_hash', contentHash)
      .limit(1);
    if (hashExisting && hashExisting.length > 0) {
      console.log(`[SMART_CRUD] content_hash HIT — skipping duplicate`);
      dedupSkipped++;
      saved.push({ id: (hashExisting[0] as { id: string }).id, content: item.content });
      continue;
    }

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
      content_hash: contentHash,
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
// Edges built from co-occurrence: entities in the same knowledge item get an edge
// weighted by how many items they appear together in. No LLM needed.
export async function upsertEntityGraph(
  entityObjects: EntityObject[],
  perItemEntities?: EntityObject[][],
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

  if (nodeIdMap.size < 2) return;

  // Build co-occurrence edges: count how many items each entity pair appears in together
  // Fall back to treating all entities as one item if per-item data not provided
  const itemGroups: EntityObject[][] = (perItemEntities && perItemEntities.length > 0)
    ? perItemEntities
    : [unique];

  const coOccurrenceMap = new Map<string, number>();
  for (const itemEntities of itemGroups) {
    const knownNames = itemEntities.map(e => e.name).filter(n => nodeIdMap.has(n));
    for (let i = 0; i < knownNames.length - 1; i++) {
      for (let j = i + 1; j < knownNames.length; j++) {
        // Canonical key: lexicographically smaller name first (undirected edge)
        const [a, b] = knownNames[i] < knownNames[j]
          ? [knownNames[i], knownNames[j]]
          : [knownNames[j], knownNames[i]];
        const key = `${a}|${b}`;
        coOccurrenceMap.set(key, (coOccurrenceMap.get(key) ?? 0) + 1);
      }
    }
  }

  if (coOccurrenceMap.size === 0) return;

  const edgeRows: { source_id: string; target_id: string; relationship: string; weight: number }[] = [];
  for (const [key, count] of coOccurrenceMap) {
    const [aName, bName] = key.split('|');
    const srcId = nodeIdMap.get(aName);
    const tgtId = nodeIdMap.get(bName);
    if (!srcId || !tgtId) continue;
    edgeRows.push({ source_id: srcId, target_id: tgtId, relationship: 'co_occurs', weight: count });
  }

  if (edgeRows.length > 0) {
    const { error: edgeErr } = await supabase
      .from('entity_edges')
      .upsert(edgeRows, { onConflict: 'source_id,target_id,relationship', ignoreDuplicates: true });
    if (edgeErr) {
      console.error('[entity_graph] upsert edges error:', edgeErr.message);
    }
  }

  console.log(`[entity_graph] upserted ${toInsert.length} new nodes, updated ${toUpdate.length}, ${edgeRows.length} co-occurrence edges`);
}

// T516: Auto-generate actionable ideas from high-score knowledge items using Haiku
// Runs after saveExtractedKnowledge — creates ideas with source='auto_haiku' and knowledge_id linkage
export async function generateAutoIdeas(
  savedKnowledge: { id: string; content: string }[],
  allItems: { content: string; immediate_relevance: number; knowledge_type: string; tags: string[]; entity_objects?: { name: string; type: string }[] }[],
  sourceUrl: string,
  sourceType: string,
): Promise<number> {
  if (savedKnowledge.length === 0) return 0;

  // Filter high-score items only (max 5 to stay within max_tokens=256)
  const itemMap = new Map(allItems.map(i => [i.content, i]));
  const candidates = savedKnowledge.filter(s => {
    const item = itemMap.get(s.content);
    return item && item.immediate_relevance >= 0.7;
  }).slice(0, 5);

  if (candidates.length === 0) return 0;

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[auto-ideas] client init failed:', err);
    return 0;
  }

  // Use Haiku to generate action-oriented ideas
  const itemsText = candidates.map((s, i) => {
    const item = itemMap.get(s.content)!;
    const clean = s.content.replace(/^\[GUIDE\]\s*/, '').slice(0, 300);
    return `${i + 1}. [score:${item.immediate_relevance.toFixed(2)}] ${clean}`;
  }).join('\n');

  const prompt = `Ты генерируешь actionable идеи для разработчика. Стек: Node.js, TypeScript, Supabase, Claude/Haiku, Vercel, Telegram Bot API, pgvector.

Для каждого knowledge item сгенерируй ОДНУ идею — конкретное действие.
ПРАВИЛА:
- Начинай с глагола: Внедрить/Добавить/Настроить/Попробовать/Мигрировать/Исследовать
- Называй конкретный инструмент и цель: "Внедрить pgvector HNSW index в extracted_knowledge"
- Все идеи на русском языке
- Если item — факт без actionable применения → верни null для этого item
- Вики-тест: если к идее можно добавить "— Википедия" → это не идея, верни null

Items:
${itemsText}

Верни ТОЛЬКО JSON массив строк (или null), одно значение на item:
["идея 1", "идея 2", null]`;

  let ideas: (string | null)[] = [];
  try {
    const haikuClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
    const msg = await haikuClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });
    const u = msg.usage as { input_tokens: number; output_tokens: number };
    const ideaCost = (u.input_tokens * 0.25 + u.output_tokens * 1.25) / 1_000_000;
    logHaikuCost({ inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: ideaCost, source: 'auto_ideas' }).catch(() => { /* non-blocking */ });
    const raw = (msg.content[0] as { type: string; text?: string }).text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      ideas = JSON.parse(cleaned.slice(start, end + 1)) as (string | null)[];
    }
  } catch (e) {
    console.error('[auto-ideas] Haiku call failed:', e instanceof Error ? e.message : String(e));
    return 0;
  }

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const ideaText = ideas[i];
    if (!ideaText || typeof ideaText !== 'string' || ideaText.trim().length < 5) continue;
    const saved = candidates[i];
    const item = itemMap.get(saved.content)!;
    rows.push({
      content: ideaText.trim().slice(0, 500),
      summary: ideaText.trim().slice(0, 80),
      ai_category: item.knowledge_type,
      source_type: sourceType,
      source_url: sourceUrl,
      source: 'auto_haiku',
      relevance: 'hot',
      status: 'new',
      knowledge_id: saved.id,
      project_id: null,
    });
  }

  if (rows.length === 0) return 0;

  // Idempotency: skip knowledge_ids that already have ideas (prevents retry-loop duplicates)
  const knowledgeIds = rows.map(r => r.knowledge_id as string).filter(Boolean);
  if (knowledgeIds.length > 0) {
    const { data: existingIdeas } = await supabase.from('ideas').select('knowledge_id').in('knowledge_id', knowledgeIds);
    const existingIds = new Set((existingIdeas ?? []).map((i: { knowledge_id: string }) => i.knowledge_id));
    const deduped = rows.filter(r => !existingIds.has(r.knowledge_id as string));
    if (deduped.length < rows.length) {
      console.log(`[auto-ideas] idempotency: skipped ${rows.length - deduped.length} already-existing idea(s)`);
    }
    if (deduped.length === 0) return 0;
    rows.length = 0;
    rows.push(...deduped);
  }

  const { error } = await supabase.from('ideas').insert(rows);
  if (error) {
    console.error('[auto-ideas] INSERT failed:', error.message);
    return 0;
  }

  console.log(`[auto-ideas] Haiku generated ${rows.length} ideas from ${candidates.length} high-score knowledge items`);
  return rows.length;
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

// Source quality scoring — upsert domain-level stats after each processing
export async function upsertSourceQuality(
  sourceUrl: string,
  overallImmediate: number,
  overallStrategic: number,
  entityCount: number,
  success: boolean,
): Promise<void> {
  let domain: string;
  try {
    domain = new URL(sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    return; // not a valid URL (manual paste, etc.)
  }

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    console.error('[source_quality] client init failed:', err);
    return;
  }

  // Fetch existing stats
  const { data: existing } = await supabase
    .from('source_quality')
    .select('avg_score, avg_strategic, success_rate, avg_entity_count, total_processed')
    .eq('domain', domain)
    .limit(1)
    .single();

  const prev = existing as { avg_score: number; avg_strategic: number; success_rate: number; avg_entity_count: number; total_processed: number } | null;
  const n = (prev?.total_processed ?? 0);
  const avgScore = (overallImmediate + overallStrategic) / 2;

  // Incremental average: new_avg = (old_avg * n + new_value) / (n + 1)
  const total = n + 1;
  const newAvgScore = n > 0 ? (prev!.avg_score * n + avgScore) / total : avgScore;
  const newAvgStrategic = n > 0 ? (prev!.avg_strategic * n + overallStrategic) / total : overallStrategic;
  const newSuccessRate = n > 0 ? (prev!.success_rate * n + (success ? 1 : 0)) / total : (success ? 1 : 0);
  const newAvgEntityCount = n > 0 ? (prev!.avg_entity_count * (total - 1) + entityCount) / total : entityCount;

  const row = {
    domain,
    avg_score: +newAvgScore.toFixed(4),
    avg_strategic: +newAvgStrategic.toFixed(4),
    success_rate: +newSuccessRate.toFixed(4),
    avg_entity_count: +newAvgEntityCount.toFixed(2),
    total_processed: total,
    last_processed_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('source_quality')
    .upsert(row, { onConflict: 'domain' });

  if (error) {
    console.error('[source_quality] upsert failed:', error.message);
  } else {
    console.log(`[source_quality] ${domain}: score=${row.avg_score} success=${row.success_rate} entities=${row.avg_entity_count} n=${row.total_processed}`);
  }
}

// Fire-and-forget Haiku cost tracker — writes to context_snapshots for /api/stats/cost aggregation
export async function logHaikuCost(params: {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  source: string;
}): Promise<void> {
  const url = process.env.PITSTOP_SUPABASE_URL ?? process.env.SUPABASE_PITSTOP_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY ?? process.env.SUPABASE_PITSTOP_ANON_KEY;
  if (!url || !key) return;
  try {
    const supabase = createClient(url, key);
    await supabase.from('context_snapshots').insert({
      snapshot_type: 'haiku_cost_log',
      content: {
        type: 'haiku_cost_log',
        date: new Date().toISOString().slice(0, 10),
        input_tokens: params.inputTokens,
        output_tokens: params.outputTokens,
        cache_write_tokens: params.cacheWriteTokens,
        cache_read_tokens: params.cacheReadTokens,
        cost_usd: params.costUsd,
        source: params.source,
      },
    });
  } catch { /* non-blocking */ }
}
