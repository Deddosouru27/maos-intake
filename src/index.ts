import 'dotenv/config';
import { createHash } from 'crypto';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { extractFileText, detectFileSource, FileSourceType } from './handlers/file';
import { fetchYouTubeText, extractVideoId } from './handlers/youtube';
import { analyzeContent, analyzeWithChunking } from './services/analyze';
import { checkSourceUrlDedup, checkContentHashDedup, insertIngestedPending, updateIngestedDone, quarantineIngestedItem, saveExtractedKnowledge, generateAutoIdeas, saveToPitstop, upsertEntityGraph, upsertSourceQuality } from './services/pitstop';
import { rerankItems } from './services/rerank';
import { dedupItems } from './lib/internalDedup';
import { fetchArticle, fetchWithJina } from './handlers/article';
import { fetchInstagramTranscript } from './apify';
import { getFullContext } from './services/projectContext';
import { logFailedAndContinue } from './lib/logFailedAndContinue';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem, RoutedTo } from './types';

async function writeContextSnapshot(
  url: string,
  sourceType: string,
  knowledgeCount: number,
  ideasCount: number,
  analysis: BrainAnalysis,
  pipelineStart: number,
  error?: string,
): Promise<void> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL ?? process.env.SUPABASE_PITSTOP_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY ?? process.env.SUPABASE_PITSTOP_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) return;
  const allEntities = analysis.knowledge_items.flatMap((i) => i.tags ?? []).filter(Boolean);
  const entitiesCount = new Set(allEntities).size;
  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);
  const content = {
    type: 'intake_processing_log',
    url,
    source_type: sourceType,
    knowledge_count: knowledgeCount,
    ideas_count: ideasCount,
    entities_count: entitiesCount,
    status: error ? 'error' : 'success',
    ...(error ? { error } : {}),
    date: new Date().toISOString(),
  };

  const { data, error: insertErr } = await sb
    .from('context_snapshots')
    .insert({ snapshot_type: 'intake_processing_log', content })
    .select('id')
    .single();

  if (insertErr) {
    console.warn('[PIPELINE] context_snapshot insert failed:', insertErr.message);
    return;
  }

  const snapshotId = (data as { id: string } | null)?.id;
  console.log(`[PIPELINE] context_snapshot written (knowledge:${knowledgeCount} ideas:${ideasCount} entities:${entitiesCount} duration:${Date.now() - pipelineStart}ms)`);

  // Auto-embed: generate embedding from content JSON for semantic search
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!snapshotId || !openaiKey) return;

  try {
    const { default: OpenAI } = await import('openai');
    const oai = new OpenAI({ apiKey: openaiKey });
    const resp = await oai.embeddings.create({
      model: 'text-embedding-3-small',
      input: JSON.stringify(content).slice(0, 8000),
      dimensions: 512,
    });
    const embedding = resp.data[0].embedding;
    const { error: updateErr } = await sb
      .from('context_snapshots')
      .update({ embedding })
      .eq('id', snapshotId);
    if (updateErr) {
      console.warn('[PIPELINE] context_snapshot embedding update failed:', updateErr.message);
    } else {
      console.log('[PIPELINE] context_snapshot embedding saved');
    }
  } catch (e) {
    console.warn('[PIPELINE] context_snapshot embedding failed (non-fatal):', e instanceof Error ? e.message : String(e));
  }
}

// --- Retry with backoff (lesson from 29.03 cost incident) ---
// 30s → 120s backoff, max 2 retries (3 total attempts), then mark failed
const RETRY_BACKOFFS_MS = [30_000, 120_000] as const;
const MAX_RETRIES = 2;

interface RetryResult<T> {
  result: T;
  attempts: number;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  isValidationError: (err: unknown) => boolean,
): Promise<RetryResult<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.log(`[RETRY] ${label} succeeded on attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
      }
      return { result, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);

      // Validation / 4xx errors — no retry, fail immediately
      if (isValidationError(err)) {
        console.error(`[RETRY] ${label} validation error (no retry): ${msg}`);
        throw err;
      }

      // Circuit breaker — no retry, fail immediately
      if (err && typeof err === 'object' && 'circuitBreaker' in err) {
        console.error(`[RETRY] ${label} circuit breaker tripped (no retry): ${msg}`);
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const backoffMs = RETRY_BACKOFFS_MS[attempt];
        console.warn(`[RETRY] ${label} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${msg} — retrying in ${backoffMs / 1000}s`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        console.error(`[RETRY] ${label} exhausted ${MAX_RETRIES + 1} attempts: ${msg}`);
      }
    }
  }
  throw lastError;
}

function isPipelineValidationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes('invalid') || msg.includes('400');
}

async function markUrlFailed(url: string, error: string, attempts: number): Promise<void> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) return;

  try {
    const sb = createClient(pitstopUrl, pitstopKey);

    // Mark any in-progress ingested_content as 'failed'
    const { data: pending } = await sb
      .from('ingested_content')
      .select('id')
      .eq('source_url', url)
      .eq('processing_status', 'processing')
      .limit(1);
    if (pending && pending.length > 0) {
      await sb
        .from('ingested_content')
        .update({ processing_status: 'failed' })
        .eq('id', pending[0].id);
      console.log(`[RETRY] Marked ingested_content ${pending[0].id} as failed`);
    }

    // Log to agent_events
    await sb.from('agent_events').insert({
      event_type: 'pipeline_failed',
      details: { url, error, attempts, exhausted: true, ts: new Date().toISOString() },
    });
  } catch (e) {
    console.error('[RETRY] markUrlFailed DB write failed:', e instanceof Error ? e.message : String(e));
  }
}

async function writeIntakeLog(fields: {
  url: string;
  stage: string;
  haiku_items?: number;
  saved_items?: number;
  dedup_skipped?: number;
  smart_crud_updates?: number;
  duration_ms?: number;
  error?: string | null;
}): Promise<void> {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) return;
  try {
    await createClient(url, key).from('intake_logs').insert(fields);
  } catch (e) {
    console.error('[intake_logs] write failed:', e instanceof Error ? e.message : String(e));
  }
}

const app = express();
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://pitstop-dusky.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use((req: Request, _res: Response, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const processLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Слишком много запросов. Подожди минуту.' },
  standardHeaders: true,
  legacyHeaders: false,
});

type Source = 'youtube' | 'instagram' | 'article' | 'url' | 'thread';

const VALID_SOURCES = new Set<string>(['youtube', 'instagram', 'article', 'thread']);

interface ProcessBody {
  url?: string;
  source?: Source;
  text?: string;
  title?: string;
  source_type?: string;
}

function detectSource(url: string, provided?: string): Source {
  // URL patterns are authoritative — always checked first
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('twitter.com') || url.includes('x.com') || url.includes('threads.net')) return 'thread';
  if (url.includes('habr.com') || url.includes('medium.com') || url.includes('dev.to')) return 'article';
  // Fall back to caller hint only if it's a known valid value
  if (provided && VALID_SOURCES.has(provided)) return provided as Source;
  return 'article';
}

function computeHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

function routeItems(items: KnowledgeItem[]): RoutedKnowledgeItem[] {
  return items.map((item) => {
    let routed_to: RoutedTo;
    if (item.immediate_relevance >= 0.7 || item.has_ready_code) {
      routed_to = 'hot_backlog';
    } else if (item.strategic_relevance >= 0.5) {
      routed_to = 'knowledge_base';
    } else {
      routed_to = 'discarded';
    }
    return { ...item, routed_to };
  });
}

function buildNotification(routed: RoutedKnowledgeItem[]): string {
  const hot = routed.filter((i) => i.routed_to === 'hot_backlog').length;
  const strategic = routed.filter((i) => i.routed_to === 'knowledge_base').length;
  if (hot > 0) return `🔥 ${hot} идей для текущих задач`;
  if (strategic > 0) return `📚 ${strategic} знаний сохранено в базу`;
  return '📭 Нерелевантен для наших направлений';
}

let lastHeartbeatAt: string | null = null;

/** GET /status — lightweight health ping, no DB calls. */
app.get('/status', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'maos-intake',
    timestamp: new Date().toISOString(),
    version: '1.0',
  });
});

/** GET /health — full health check with Supabase counts. Query: ?preflight=true for Telegram test. 503 if degraded. */
app.get('/health', async (req: Request, res: Response) => {
  const key = (name: string) => (process.env[name] ? 'connected' : 'missing_key');
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const isPreflight = req.query.preflight === 'true';

  let knowledge_count = 0;
  let entity_count = 0;
  let pending_ingestion = 0;
  let pending_tasks = 0;
  let supabase_ok = false;
  let last_processed: string | null = null;
  let knowledge_without_embedding = 0;

  if (pitstopUrl && pitstopKey) {
    try {
      const { createClient: mk } = await import('@supabase/supabase-js');
      const sb = mk(pitstopUrl, pitstopKey);
      const queries = [
        sb.from('extracted_knowledge').select('*', { count: 'exact', head: true }),
        sb.from('extracted_knowledge').select('*', { count: 'exact', head: true }).not('entity_objects', 'is', null).neq('entity_objects', '[]'),
        sb.from('ingested_content').select('*', { count: 'exact', head: true }).eq('processing_status', 'pending'),
        sb.from('extracted_knowledge').select('created_at').order('created_at', { ascending: false }).limit(1),
        sb.from('extracted_knowledge').select('*', { count: 'exact', head: true }).is('embedding', null),
      ] as const;
      const base = await Promise.all(queries);
      knowledge_count = base[0].count ?? 0;
      entity_count = base[1].count ?? 0;
      pending_ingestion = base[2].count ?? 0;
      last_processed = (base[3].data?.[0] as { created_at: string } | undefined)?.created_at ?? null;
      knowledge_without_embedding = base[4].count ?? 0;
      supabase_ok = true;

      if (isPreflight) {
        const { count: tc } = await sb.from('tasks').select('*', { count: 'exact', head: true }).not('status', 'in', '("done","cancelled")');
        pending_tasks = tc ?? 0;
      }
    } catch { /* non-fatal */ }
  }

  // Preflight: test Telegram connectivity
  let telegram_ok: boolean | undefined;
  if (isPreflight) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      try {
        const tgResp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: '✅ Preflight check: Intake сервис работает.' }),
          signal: AbortSignal.timeout(5000),
        });
        telegram_ok = tgResp.ok;
      } catch {
        telegram_ok = false;
      }
    } else {
      telegram_ok = false;
    }
  }

  const embeddingMissingRatio = knowledge_count > 0 ? knowledge_without_embedding / knowledge_count : 0;
  const embedding_degraded = supabase_ok && embeddingMissingRatio > 0.05;
  const overallStatus = !supabase_ok ? 'degraded' : embedding_degraded ? 'degraded' : 'ok';

  const response: Record<string, unknown> = {
    status: overallStatus,
    version: '1.0.0',
    knowledge_count,
    knowledge_without_embedding,
    entity_count,
    pending_ingestion,
    last_heartbeat: lastHeartbeatAt,
    last_processed,
    supabase: supabase_ok ? 'connected' : 'error',
    uptime: 'ok',
    services: {
      anthropic: key('ANTHROPIC_API_KEY'),
      gemini: key('GEMINI_API_KEY'),
      groq: key('GROQ_API_KEY'),
      openai: key('OPENAI_API_KEY'),
      pitstop_supabase: key('PITSTOP_SUPABASE_ANON_KEY'),
      memory_supabase: key('MEMORY_SUPABASE_ANON_KEY'),
    },
  };

  if (isPreflight) {
    response.telegram = telegram_ok;
    response.pending_tasks = pending_tasks;
  }

  res.status(overallStatus === 'ok' ? 200 : 503).json(response);
});

// Phase 1: fetch raw content (no analysis — allows dedup check before API call)
async function fetchRawContent(
  url: string,
  source: Source,
): Promise<{ rawText: string; title?: string; youtube_unavailable?: true }> {
  if (source === 'youtube') {
    try {
      const { title, text } = await fetchYouTubeText(url);
      if (text && text.length > 50) return { rawText: text, title };
    } catch (err) {
      console.log('[INTAKE] YouTube fetch failed:', err instanceof Error ? err.message : String(err));
    }
    return { rawText: '', youtube_unavailable: true };
  }

  if (source === 'thread') {
    const { fetchThread } = await import('./handlers/threads');
    const thread = await fetchThread(url);
    return { rawText: thread.text || url };
  }

  if (source === 'instagram' || url.includes('instagram.com')) {
    console.log('[INTAKE] Instagram URL detected, calling Apify...');
    const apifyResult = await fetchInstagramTranscript(url);
    if (apifyResult) {
      console.log('[INTAKE] Apify returned:', apifyResult.text.length, 'chars');
      return { rawText: apifyResult.text, title: apifyResult.title };
    }
    console.log('[INTAKE] Apify failed, falling back to Jina');
    const jinaResult = await fetchWithJina(url);
    if (jinaResult && jinaResult.text.length > 100) {
      return { rawText: jinaResult.text, title: jinaResult.title };
    }
    return { rawText: '' };
  }

  // Sites that serve static HTML well — skip Jina to avoid sidebar/nav extraction
  const PREFER_DIRECT_DOMAINS = new Set(['habr.com', 'dev.to', 'vc.ru', 'tproger.ru', 'vas3k.ru', 'tinkoff.ru']);
  let preferDirect = false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    preferDirect = PREFER_DIRECT_DOMAINS.has(hostname);
  } catch { /* invalid URL, fall through */ }

  if (!preferDirect) {
    // Jina Reader first — handles paywalls and JS-heavy sites better
    const jinaResult = await fetchWithJina(url);
    if (jinaResult && jinaResult.text.length > 100) {
      console.log('[INTAKE] Jina ok, length:', jinaResult.text.length);
      return { rawText: jinaResult.text, title: jinaResult.title };
    }
    console.log('[INTAKE] Jina failed, falling back to readability');
  } else {
    console.log('[INTAKE] Skipping Jina for direct-extraction domain, using cheerio');
  }

  // Cheerio-based extraction (removes sidebar/nav/footer)
  const { text, title } = await fetchArticle(url);
  return { rawText: text, title };
}

// Phase 3: route + persist
async function runPipeline(
  ingestedId: string | null,
  analysis: BrainAnalysis,
  sourceUrl: string,
  sourceType: string,
  contentHash: string,
): Promise<{ notification: string; haikuItems: number; itemsToSave: number; savedItems: number; dedupSkipped: number; smartCrudUpdates: number; haikuRaw: string | null }> {
  const pipelineStart = Date.now();
  // Guide detection
  const guidePattern = /guide|tutorial|step-by-step|how to|гайд|инструкция/i;
  const isGuide = guidePattern.test(analysis.summary);
  if (isGuide) console.log('[PIPELINE] Guide content detected');

  // Rerank if > 5 items (requires COHERE_API_KEY)
  const rankedItems = await rerankItems(analysis.summary, analysis.knowledge_items);

  // Intra-article semantic dedup: remove near-duplicate items before routing
  const { items: dedupedItems, removed: dedupRemovedCount } = dedupItems(rankedItems);
  if (dedupRemovedCount > 0) {
    console.log(`[DEDUP] Removed ${dedupRemovedCount} intra-article duplicate items (Jaccard≥0.7)`);
  }

  const routed = routeItems(dedupedItems);
  const hotItems = routed.filter((i) => i.routed_to === 'hot_backlog');
  const strategicItems = routed.filter((i) => i.routed_to === 'knowledge_base');
  // Strategic ideas: knowledge_base items with immediate_relevance 0.5–0.69 → appear in ideas as 'strategic'
  const strategicIdeas = strategicItems.filter((i) => i.immediate_relevance >= 0.5);
  const discarded = routed.filter((i) => i.routed_to === 'discarded');
  const notification = buildNotification(routed);
  const routingResult = `hot:${hotItems.length},strategic:${strategicItems.length},discarded:${discarded.length}`;

  console.log(`[PIPELINE] routing: ${routingResult}, hash: ${contentHash.slice(0, 8)}`);

  // Filter discarded items — don't pollute extracted_knowledge with noise
  const itemsToSave = routed.filter((i) => i.strategic_relevance >= 0.3 || i.immediate_relevance >= 0.3);

  // Prepend [GUIDE] summary item for guide content
  if (isGuide) {
    itemsToSave.unshift({
      content: '[GUIDE] ' + analysis.summary,
      knowledge_type: 'guide',
      project: null,
      domains: [],
      solves_need: null,
      immediate_relevance: 0.8,
      strategic_relevance: 0.8,
      novelty: 0.5,
      effort: 'medium',
      has_ready_code: false,
      business_value: null,
      tags: ['guide'],
      routed_to: 'knowledge_base',
    });
  }
  console.log(`[PIPELINE] items to save: ${itemsToSave.length}/${routed.length} (discarded noise: ${routed.length - itemsToSave.length})`);

  // Update ingested_content with analysis results (use post-filter count)
  if (ingestedId) {
    await updateIngestedDone(ingestedId, analysis, routingResult, itemsToSave.length, isGuide);
  }

  // Quarantine check — anomalous score or empty entities → flag for review
  if (ingestedId) {
    const score = analysis.overall_immediate;
    const allEntities = analysis.knowledge_items.flatMap(i => [
      ...(i.tags ?? []),
      ...(i.entity_objects ?? []).map(e => e.name),
    ]);
    const entitiesEmpty = (analysis.entities ?? []).length === 0 && allEntities.length === 0;

    let quarantineReason: string | null = null;
    if (score < 0.1) {
      quarantineReason = 'low_score';
    } else if (score > 0.95) {
      quarantineReason = 'high_score';
    } else if (entitiesEmpty) {
      quarantineReason = 'empty_entities';
    }

    if (quarantineReason) {
      console.warn(`[QUARANTINE] score=${score.toFixed(3)} entities=${allEntities.length} → ${quarantineReason}`);
      await quarantineIngestedItem(ingestedId, quarantineReason);
      // Return early — don't save anomalous knowledge to extracted_knowledge or ideas
      return {
        notification: `⚠️ Карантин: ${quarantineReason}`,
        haikuItems: analysis.knowledge_items.length,
        itemsToSave: 0,
        savedItems: 0,
        dedupSkipped: 0,
        smartCrudUpdates: 0,
        haikuRaw: null,
      };
    }
  }

  // Save extracted_knowledge first to get IDs, then link ideas
  console.log('[PIPELINE] saving extracted_knowledge...');
  let knowledgeSaved: { id: string; content: string }[] = [];
  let dedupSkipped = 0;
  let smartCrudUpdates = 0;
  try {
    const result = await saveExtractedKnowledge(itemsToSave, ingestedId, sourceUrl, sourceType);
    knowledgeSaved = result.saved;
    dedupSkipped = result.dedupSkipped;
    smartCrudUpdates = result.smartCrudUpdates;
    console.log('[PIPELINE] extracted_knowledge ok:', knowledgeSaved.length, 'saved,', dedupSkipped, 'dedup skipped,', smartCrudUpdates, 'updated');
  } catch (e) {
    console.error('[PIPELINE] extracted_knowledge failed:', e instanceof Error ? e.message : String(e));
  }

  // T516: Auto-generate ideas from high-score knowledge (source='auto', knowledge_id linked)
  let autoIdeasCount = 0;
  try {
    autoIdeasCount = await generateAutoIdeas(knowledgeSaved, itemsToSave, sourceUrl, sourceType);
    if (autoIdeasCount > 0) console.log(`[PIPELINE] auto-ideas: ${autoIdeasCount} generated`);
  } catch (e) {
    console.error('[PIPELINE] auto-ideas failed (non-fatal):', e instanceof Error ? e.message : String(e));
  }

  console.log('[PIPELINE] saving ideas...');
  try {
    await saveToPitstop(analysis, hotItems, sourceType, sourceUrl, knowledgeSaved, strategicIdeas);
    console.log('[PIPELINE] ideas ok');
  } catch (e) {
    console.error('[PIPELINE] ideas failed:', e instanceof Error ? e.message : String(e));
  }

  // Upsert entity graph — co-occurrence edges built from per-item entity lists (no LLM cost)
  try {
    const perItemEntities = itemsToSave.map(i => i.entity_objects ?? []).filter(arr => arr.length > 0);
    const allEntityObjects = perItemEntities.flat();
    if (allEntityObjects.length > 0) {
      await upsertEntityGraph(allEntityObjects, perItemEntities);
    }
  } catch (e) {
    console.error('[PIPELINE] entity_graph failed (non-fatal):', e instanceof Error ? e.message : String(e));
  }

  // Write-after-action: context_snapshot
  writeContextSnapshot(sourceUrl, sourceType, knowledgeSaved.length, hotItems.length + strategicIdeas.length, analysis, pipelineStart).catch((e) => {
    console.warn('[PIPELINE] context_snapshot failed (non-fatal):', e instanceof Error ? e.message : String(e));
  });

  // Source quality scoring — track domain-level stats
  const allEntitiesForQuality = analysis.knowledge_items.flatMap(i => [
    ...(i.tags ?? []),
    ...(i.entity_objects ?? []).map(e => e.name),
  ]);
  const uniqueEntityCount = new Set(allEntitiesForQuality).size;
  upsertSourceQuality(sourceUrl, analysis.overall_immediate, analysis.overall_strategic, uniqueEntityCount, true).catch((e) => {
    console.warn('[PIPELINE] source_quality failed (non-fatal):', e instanceof Error ? e.message : String(e));
  });

  return {
    notification,
    haikuItems: analysis.knowledge_items.length,
    itemsToSave: itemsToSave.length,
    savedItems: knowledgeSaved.length,
    dedupSkipped,
    smartCrudUpdates,
    haikuRaw: null,
  };
}

interface PipelineDiag { haikuItems: number; itemsToSave: number; savedItems: number; dedupSkipped: number; smartCrudUpdates: number; haikuRaw: string | null }

// T490: Queue YouTube URL to content_discovery for Runner processing (no egress restrictions)
async function queueYouTubeForRunner(url: string, reason: string): Promise<boolean> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) return false;
  try {
    const sb = createClient(pitstopUrl, pitstopKey);
    // Check if already queued
    const { data: existing } = await sb.from('content_discovery').select('id').eq('url', url).limit(1);
    if (existing && existing.length > 0) {
      console.log(`[youtube-queue] already queued: ${url}`);
      return true;
    }
    const { error } = await sb.from('content_discovery').insert({
      url, source: 'youtube_queue', status: 'pending_youtube', title: null, topic: reason,
    });
    if (error) {
      console.error('[youtube-queue] insert failed:', error.message);
      return false;
    }
    console.log(`[youtube-queue] queued for Runner: ${url} (${reason})`);
    return true;
  } catch (e) {
    console.error('[youtube-queue] error:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function fullPipeline(url: string, source: Source): Promise<{ notification: string; analysis: BrainAnalysis; diag: PipelineDiag } | { duplicate: true } | { youtube_unavailable: true; _gemini_error?: string; _queued?: boolean }> {
  // 45s hard timeout — Vercel maxDuration is 60s, leaves buffer for network
  const timeoutId = setTimeout(() => {
    throw new Error('[INTAKE] Pipeline timeout (45s)');
  }, 45000);

  const startTime = Date.now();
  try {
    console.log('[PIPELINE] Starting for URL:', url, '| source:', source);

    // URL dedup: skip if same URL exists in ingested_content (done, processing, quarantined)
    const urlDedup = await checkSourceUrlDedup(url);
    if (urlDedup.exists) {
      console.log(`[PIPELINE] URL dedup HIT — skipping: ${url} (status: ${urlDedup.status})`);
      await writeIntakeLog({ url, stage: 'dedup_skip', duration_ms: Date.now() - startTime });
      return { duplicate: true };
    }
    console.log('[PIPELINE] URL dedup passed');

    const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
    const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;

    // YouTube + Gemini: skip transcript fetch entirely — Gemini reads video natively
    const useGemini = source === 'youtube' && !!process.env.GEMINI_API_KEY;
    let rawText = '';
    let title: string | undefined;

    if (!useGemini) {
      console.log('[PIPELINE] 1. Fetching content...');
      const fetched = await fetchRawContent(url, source);

      if (fetched.youtube_unavailable) {
        const queued = await queueYouTubeForRunner(url, 'transcript_unavailable');
        return { youtube_unavailable: true, _queued: queued };
      }

      rawText = fetched.rawText;
      title = fetched.title;
      console.log(`[PIPELINE] 2. Fetched ${rawText.length} chars, title: ${title ?? 'none'}`);

      if (rawText.length < 30) {
        console.error('[PIPELINE] Content too short or empty — aborting, rawText:', JSON.stringify(rawText));
        return { notification: '⚠️ Контент не получен (пустой ответ от источника)', analysis: { summary: '', knowledge_items: [], overall_immediate: 0, overall_strategic: 0, priority_signal: false, priority_reason: '', category: 'empty', language: 'other' }, diag: { haikuItems: 0, itemsToSave: 0, savedItems: 0, dedupSkipped: 0, smartCrudUpdates: 0, haikuRaw: null } };
      }
    } else {
      console.log('[PIPELINE] 1. Gemini path — skipping transcript fetch');
    }

    const contentHash = computeHash(rawText || url);
    console.log('[PIPELINE] 3. Content hash:', contentHash.slice(0, 8));

    let context;
    try {
      context = await getFullContext();
    } catch (err) {
      console.error('[PIPELINE] getFullContext FAILED:', err instanceof Error ? err.message : String(err));
      throw err;
    }
    console.log('[PIPELINE] 4. Context ok — projects:', context.projects.length, 'domains:', context.domains.length, 'recentHashes:', context.recentHashes.length);

    // In-memory cache check (fast path)
    if (context.recentHashes.includes(contentHash)) {
      console.log('[PIPELINE] Content hash dedup HIT (cache):', contentHash.slice(0, 8));
      await writeIntakeLog({ url, stage: 'content_hash_dedup', duration_ms: Date.now() - startTime });
      return { duplicate: true };
    }
    // DB check — catches same content from different URLs (done, processing, quarantined)
    const hashDedup = await checkContentHashDedup(contentHash);
    if (hashDedup.exists) {
      console.log(`[PIPELINE] Content hash dedup HIT (DB) — same content as ${hashDedup.sourceUrl}`);
      await writeIntakeLog({ url, stage: 'content_hash_dedup', duration_ms: Date.now() - startTime });
      return { duplicate: true };
    }

    // YouTube dedup by video ID (hash may differ due to caption format changes)
    if (source === 'youtube') {
      const videoId = extractVideoId(url);
      if (videoId && context.recentHashes.length > 0) {
        if (pitstopUrl && pitstopKey) {
          const sb = createClient(pitstopUrl, pitstopKey);
          const { data } = await sb.from('ingested_content').select('id').ilike('source_url', `%${videoId}%`).eq('processing_status', 'done').limit(1);
          if (data && data.length > 0) {
            console.log('[PIPELINE] YouTube video ID dedup HIT:', videoId);
            return { duplicate: true };
          }
        }
      }
    }

    // ── Pre-filter: deterministic checks before any LLM call ──────────────────
    if (!useGemini && rawText.length > 0) {
      // 1. Word count < 100 → skip (not enough content to extract anything useful)
      const wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount < 100) {
        console.log(`[PRE-FILTER] word_count=${wordCount} < 100 — skipping LLM`);
        await writeIntakeLog({ url, stage: 'pre_filter_skip', duration_ms: Date.now() - startTime, error: `word_count=${wordCount}` });
        return { notification: `⏭ Pre-filter: слишком мало контента (${wordCount} слов, минимум 100). LLM не вызван.`, analysis: { summary: '', knowledge_items: [], overall_immediate: 0, overall_strategic: 0, priority_signal: false, priority_reason: '', category: 'pre_filter_skip', language: 'other' }, diag: { haikuItems: 0, itemsToSave: 0, savedItems: 0, dedupSkipped: 0, smartCrudUpdates: 0, haikuRaw: null } };
      }

      // 2. Language detection: skip if not ru/en
      // Heuristic: count Cyrillic chars for ru, Latin chars for en
      const cyrillicCount = (rawText.match(/[\u0400-\u04FF]/g) ?? []).length;
      const latinCount = (rawText.match(/[a-zA-Z]/g) ?? []).length;
      const totalAlpha = cyrillicCount + latinCount;
      const isRu = totalAlpha > 0 && cyrillicCount / totalAlpha > 0.3;
      const isEn = totalAlpha > 0 && latinCount / totalAlpha > 0.5;
      if (!isRu && !isEn) {
        const langRatio = totalAlpha > 0 ? `cy=${Math.round(cyrillicCount/totalAlpha*100)}% la=${Math.round(latinCount/totalAlpha*100)}%` : 'no alpha';
        console.log(`[PRE-FILTER] language not ru/en (${langRatio}) — skipping LLM`);
        await writeIntakeLog({ url, stage: 'pre_filter_skip', duration_ms: Date.now() - startTime, error: `lang_mismatch: ${langRatio}` });
        return { notification: `⏭ Pre-filter: язык не ru/en (${langRatio}). LLM не вызван.`, analysis: { summary: '', knowledge_items: [], overall_immediate: 0, overall_strategic: 0, priority_signal: false, priority_reason: '', category: 'pre_filter_skip', language: 'other' }, diag: { haikuItems: 0, itemsToSave: 0, savedItems: 0, dedupSkipped: 0, smartCrudUpdates: 0, haikuRaw: null } };
      }

      console.log(`[PRE-FILTER] passed — words=${wordCount} cy=${cyrillicCount} la=${latinCount}`);
    }
    // ── End pre-filter ────────────────────────────────────────────────────────

    console.log('[PIPELINE] 4.5. Inserting ingested_content (pending)...');
    const ingestedId = await insertIngestedPending(rawText, url, source, title, contentHash);
    console.log('[PIPELINE] 4.5. ingestedId:', ingestedId);

    console.log('[PIPELINE] 5. Analysis...');
    let analysis: BrainAnalysis;

    // YouTube: try Gemini first (native video understanding — no transcript needed)
    // Fallback: existing Haiku pipeline on any failure
    if (useGemini) {
      try {
        const { analyzeYouTubeWithGemini } = await import('./services/gemini');
        analysis = await analyzeYouTubeWithGemini(url);
        console.log(`[PIPELINE] 5a. Gemini ok — items: ${analysis.knowledge_items.length}`);
      } catch (geminiErr) {
        const geminiErrMsg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
        console.warn('[PIPELINE] Gemini failed:', geminiErrMsg);
        const failedAnalysis: BrainAnalysis = { summary: '', knowledge_items: [], overall_immediate: 0, overall_strategic: 0, priority_signal: false, priority_reason: '', category: 'failed', language: 'other' };
        // 429 quota — do NOT try transcript/Haiku fallback, just queue for later
        if (geminiErrMsg.startsWith('GEMINI_QUOTA_EXCEEDED')) {
          if (ingestedId) await updateIngestedDone(ingestedId, failedAnalysis, 'failed', 0, false, 'gemini_quota');
          const queued = await queueYouTubeForRunner(url, 'gemini_quota');
          return { youtube_unavailable: true, _gemini_error: geminiErrMsg.slice(0, 300), _queued: queued };
        }
        // Secondary fallback: try transcript
        if (rawText.length < 30) {
          console.log('[PIPELINE] Gemini failed + no rawText — trying transcript fetch');
          try {
            const transcriptFetched = await fetchRawContent(url, source);
            if (transcriptFetched.youtube_unavailable || transcriptFetched.rawText.length < 30) {
              if (ingestedId) await updateIngestedDone(ingestedId, failedAnalysis, 'youtube_unavailable', 0, false, 'failed');
              const queued = await queueYouTubeForRunner(url, 'gemini_and_transcript_failed');
              return { youtube_unavailable: true, _gemini_error: geminiErrMsg.slice(0, 300), _queued: queued };
            }
            rawText = transcriptFetched.rawText;
            title = transcriptFetched.title;
          } catch (transcriptErr) {
            console.warn('[PIPELINE] Transcript fallback also failed:', transcriptErr instanceof Error ? transcriptErr.message : String(transcriptErr));
            if (ingestedId) await updateIngestedDone(ingestedId, failedAnalysis, 'failed', 0, false, geminiErrMsg.slice(0, 200));
            const queued = await queueYouTubeForRunner(url, 'gemini_and_transcript_exception');
            return { youtube_unavailable: true, _gemini_error: geminiErrMsg.slice(0, 300), _queued: queued };
          }
        }
        console.log('[PIPELINE] Falling back to Haiku with transcript:', rawText.length, 'chars');
        analysis = await analyzeWithChunking(rawText, url);
      }
    } else {
      analysis = await analyzeWithChunking(rawText, url);
    }
    console.log(`[PIPELINE] 6. Analysis — items: ${analysis.knowledge_items.length}, immediate: ${analysis.overall_immediate.toFixed(2)}, strategic: ${analysis.overall_strategic.toFixed(2)}, category: ${analysis.category}`);

    if (analysis.category === 'parse_error' || analysis.category === 'empty_response') {
      const isEmpty = analysis.category === 'empty_response';
      const errLabel = isEmpty ? 'empty_response' : 'parse_error';
      const errMsg = isEmpty ? 'Haiku returned empty response' : 'Haiku returned non-JSON';
      console.error(`[INTAKE] ${errLabel} — skipping pipeline`);
      if (ingestedId) {
        await updateIngestedDone(ingestedId, analysis, errLabel, 0, false, errLabel);
      }
      // Log to agent_events for observability
      if (pitstopUrl && pitstopKey) {
        createClient(pitstopUrl, pitstopKey).from('agent_events').insert({
          event_type: 'llm_error',
          details: { url, reason: errLabel, error: errMsg },
        }).then(({ error: evtErr }) => { if (evtErr) console.warn('[agent_events] insert failed:', evtErr.message); });
      }
      await writeIntakeLog({ url, stage: errLabel, haiku_items: 0, duration_ms: Date.now() - startTime, error: errMsg });
      return { notification: `⚠️ ${errMsg}. Записано как ${errLabel}.`, analysis, diag: { haikuItems: 0, itemsToSave: 0, savedItems: 0, dedupSkipped: 0, smartCrudUpdates: 0, haikuRaw: analysis._haiku_raw ?? null } };
    }

    const diag = await runPipeline(ingestedId, analysis, url, source, contentHash);
    console.log(`[INTAKE] 7. Done — ${diag.notification} | haiku:${diag.haikuItems} itemsToSave:${diag.itemsToSave} saved:${diag.savedItems} dedup:${diag.dedupSkipped} updates:${diag.smartCrudUpdates}`);
    await writeIntakeLog({
      url,
      stage: 'complete',
      haiku_items: diag.haikuItems,
      saved_items: diag.savedItems,
      dedup_skipped: diag.dedupSkipped,
      smart_crud_updates: diag.smartCrudUpdates,
      duration_ms: Date.now() - startTime,
    });
    return { notification: diag.notification, analysis, diag };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** POST /process — main ingestion endpoint. URL or text paste. Pipeline: detect→fetch→dedup→Haiku→route→save. 10 req/min. */
app.post('/process', processLimiter, async (req: Request, res: Response) => {
  const { url, source: providedSource, text: bodyText, title: bodyTitle, source_type: bodySourceType } = req.body as ProcessBody;

  // Manual text paste — skip fetch, go directly to pipeline
  if ((bodyText && !url) || url === 'manual-paste') {
    const rawText = bodyText ?? '';
    if (!rawText.trim()) {
      res.status(400).json({ error: 'text is required for manual paste' });
      return;
    }
    const title = bodyTitle || 'Manual paste';
    const sourceType = (bodySourceType && bodySourceType !== 'link') ? bodySourceType : 'text';
    const label = `manual:${title.slice(0, 50)}`;

    // Batch split: "---" or "===" on its own line
    const batchParts = rawText.split(/\n---\n|\n===\n/).map((s) => s.trim()).filter((s) => s.length >= 30);
    if (batchParts.length > 1) {
      console.log(`[/process manual] batch split: ${batchParts.length} parts`);
      const batchResults: { notification: string; items: number }[] = [];
      const batchErrors: { index: number; error: string }[] = [];
      for (let i = 0; i < Math.min(batchParts.length, 10); i++) {
        try {
          const r = await rawTextPipeline(batchParts[i], sourceType, `${label}:part${i + 1}`, title);
          if ('duplicate' in r) {
            batchResults.push({ notification: '♻️ duplicate', items: 0 });
          } else {
            batchResults.push({ notification: r.notification, items: r.analysis.knowledge_items.length });
          }
        } catch (e) {
          batchErrors.push({ index: i, error: e instanceof Error ? e.message : String(e) });
        }
      }
      res.json({ status: 'batch', parts: batchParts.length, results: batchResults, errors: batchErrors });
      return;
    }

    try {
      const result = await rawTextPipeline(rawText, sourceType, label, title);
      if ('duplicate' in result) {
        res.json({ success: true, status: 'duplicate', knowledge_count: 0, source_url: label, notification: '♻️ Этот контент уже обрабатывался' });
      } else {
        res.json({ success: true, status: 'done', knowledge_count: result.analysis.knowledge_items.length, source_url: label, notification: result.notification, _diag: result.diag, ...result.analysis });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[/process manual] pipeline failed:', message);
      res.status(500).json({ success: false, error: message });
    }
    return;
  }

  if (!url) {
    res.status(400).json({ success: false, error: 'url is required' });
    return;
  }

  const source = detectSource(url, providedSource ?? bodySourceType);

  try {
    const { result, attempts } = await retryWithBackoff(
      () => fullPipeline(url, source),
      `process:${url.slice(0, 60)}`,
      isPipelineValidationError,
    );
    if ('youtube_unavailable' in result) {
      const queued = '_queued' in result && result._queued;
      res.json({
        success: true,
        status: queued ? 'queued_for_runner' : 'youtube_unavailable',
        knowledge_count: 0,
        source_url: url,
        notification: queued
          ? '📋 YouTube URL добавлен в очередь для Runner (обработается на ноутбуке)'
          : '🎬 YouTube временно недоступен. Скопируй транскрипт через youtubetotranscript.com и отправь текстом',
        _gemini_error: result._gemini_error,
        _queued: queued,
        _retry: { attempts },
      });
    } else if ('duplicate' in result) {
      res.json({ success: true, status: 'duplicate', knowledge_count: 0, source_url: url, notification: '♻️ Этот контент уже обрабатывался', _retry: { attempts } });
    } else {
      res.json({ success: true, status: 'done', knowledge_count: result.analysis.knowledge_items.length, source_url: url, notification: result.notification, _diag: result.diag, _retry: { attempts }, ...result.analysis });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/process] pipeline failed for ${url} after ${MAX_RETRIES + 1} attempts:`, message);
    // Mark failed in DB after retries exhausted
    if (!isPipelineValidationError(err)) {
      await markUrlFailed(url, message, MAX_RETRIES + 1);
      await writeIntakeLog({ url, stage: 'failed_exhausted', duration_ms: 0, error: message });
    }
    res.status(500).json({ success: false, error: message, attempts: MAX_RETRIES + 1 });
  }
});

// Shared pipeline for pre-fetched text (files, manual paste, etc.)
async function rawTextPipeline(
  rawText: string,
  sourceType: string,
  label: string,
  title?: string,
): Promise<{ notification: string; analysis: BrainAnalysis; diag: PipelineDiag } | { duplicate: true }> {
  const contentHash = computeHash(rawText);

  const context = await getFullContext();
  if (context.recentHashes.includes(contentHash)) {
    console.log('[INTAKE] Content hash dedup HIT (cache):', contentHash.slice(0, 8));
    return { duplicate: true };
  }
  const hashDedup = await checkContentHashDedup(contentHash);
  if (hashDedup.exists) {
    console.log(`[INTAKE] Content hash dedup HIT (DB) — same content as ${hashDedup.sourceUrl}`);
    return { duplicate: true };
  }

  const ingestedId = await insertIngestedPending(rawText, label, sourceType, title, contentHash);

  console.log('[INTAKE] 5. Haiku analysis...');
  const analysis = await analyzeWithChunking(rawText, label);

  const diag = await runPipeline(ingestedId, analysis, label, sourceType, contentHash);
  console.log(`[INTAKE] Done — ${diag.notification}`);
  return { notification: diag.notification, analysis, diag };
}

interface ProcessFileBody {
  buffer: string;      // base64
  filename: string;
  mime_type: string;
}

/** POST /process-file — file upload ingestion (pdf/docx/xlsx). Body: { buffer (base64), filename, mime_type }. 10 req/min. */
app.post('/process-file', processLimiter, async (req: Request, res: Response) => {
  const { buffer, filename, mime_type } = req.body as ProcessFileBody;

  if (!buffer || !filename || !mime_type) {
    res.status(400).json({ error: 'buffer, filename, and mime_type are required' });
    return;
  }

  const sourceType = detectFileSource(mime_type);
  if (!sourceType) {
    res.status(400).json({ error: `Unsupported mime_type: ${mime_type}` });
    return;
  }

  try {
    console.log(`[INTAKE] 1. Extracting text from file: ${filename} (${sourceType})`);
    const fileBuffer = Buffer.from(buffer, 'base64');
    const rawText = await extractFileText(fileBuffer, sourceType as FileSourceType);
    await rawTextPipeline(rawText, sourceType, `file:${filename}`, filename);
    res.json({ status: 'done', filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/process-file] failed for ${filename}:`, message);
    res.status(500).json({ error: message });
  }
});

interface BatchBody {
  urls?: string[];
  texts?: string[];
  text?: string;
  source_type?: string;
  title?: string;
}

/** POST /batch — legacy batch endpoint (DEPRECATED, use POST /process/batch). */
app.post('/batch', processLimiter, async (req: Request, res: Response) => {
  const { urls, texts: bodyTexts, text: bodyText, source_type: bodySourceType, title: bodyTitle } = req.body as BatchBody;

  // Text batch mode: { texts: string[] } or { text: string } split by ---
  if (bodyTexts || bodyText) {
    const blocks = bodyTexts ?? (bodyText ?? '').split(/\n---\n/).map((s) => s.trim()).filter(Boolean);
    if (blocks.length === 0) {
      res.status(400).json({ error: 'No text blocks provided' });
      return;
    }
    const sourceType = bodySourceType || 'text';
    const results: { notification: string; items: number }[] = [];
    const errors: { index: number; error: string }[] = [];
    for (let i = 0; i < Math.min(blocks.length, 10); i++) {
      try {
        const result = await rawTextPipeline(blocks[i], sourceType, `batch:${i}`, bodyTitle);
        if ('duplicate' in result) {
          results.push({ notification: '♻️ duplicate', items: 0 });
        } else {
          results.push({ notification: result.notification, items: result.analysis.knowledge_items.length });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ index: i, error: message });
      }
    }
    res.json({ processed: results.length, results, errors });
    return;
  }

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls or texts required' });
    return;
  }

  if (urls.length > 10) {
    res.status(400).json({ error: 'Maximum 10 URLs per batch' });
    return;
  }

  const results: (BrainAnalysis & { notification?: string; duplicate?: boolean })[] = [];
  const errors: { url: string; error: string }[] = [];

  for (const url of urls) {
    const source = detectSource(url);
    try {
      // URL dedup before fetching content (saves network + API cost)
      const urlDedup = await checkSourceUrlDedup(url);
      if (urlDedup.exists) {
        results.push({
          summary: '',
          knowledge_items: [],
          overall_immediate: 0,
          overall_strategic: 0,
          priority_signal: false,
          priority_reason: '',
          category: 'other',
          language: 'other',
          duplicate: true,
          notification: `♻️ Этот URL уже обрабатывался (${urlDedup.status})`,
        });
        continue;
      }

      const { rawText, title } = await fetchRawContent(url, source);
      const contentHash = computeHash(rawText);

      const context = await getFullContext();
      const cacheHit = context.recentHashes.includes(contentHash);
      const dbHit = cacheHit ? null : await checkContentHashDedup(contentHash);
      if (cacheHit || (dbHit && dbHit.exists)) {
        const reason = cacheHit ? 'cache' : `DB, same as ${dbHit?.sourceUrl}`;
        console.log(`[/batch] Content hash dedup HIT (${reason}):`, contentHash.slice(0, 8));
        results.push({
          summary: '',
          knowledge_items: [],
          overall_immediate: 0,
          overall_strategic: 0,
          priority_signal: false,
          priority_reason: '',
          category: 'other',
          language: 'other',
          duplicate: true,
          notification: `♻️ Контент уже обрабатывался (${reason})`,
        });
        continue;
      }

      const ingestedId = await insertIngestedPending(rawText, url, source, title, contentHash);
      const analysis = await analyzeContent(rawText, url);
      results.push(analysis);
      runPipeline(ingestedId, analysis, url, source, contentHash).catch(console.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[/batch] error for ${url}:`, message);
      errors.push({ url, error: message });
    }
  }

  res.json({ results, errors });
});

async function processBatchUrl(
  url: string,
  source: Source,
): Promise<{ url: string; status: 'success' | 'skipped' | 'error'; reason?: string; knowledge_count?: number; error?: string; attempts?: number }> {
  try {
    const { result, attempts } = await retryWithBackoff(
      () => fullPipeline(url, source),
      `batch:${url.slice(0, 60)}`,
      isPipelineValidationError,
    );

    if ('duplicate' in result) return { url, status: 'skipped', reason: 'duplicate', attempts };
    if ('youtube_unavailable' in result) return { url, status: 'skipped', reason: 'youtube_unavailable', attempts };
    return { url, status: 'success', knowledge_count: result.analysis.knowledge_items.length, attempts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Mark failed in DB after all retries exhausted (skip for validation errors)
    if (!isPipelineValidationError(err)) {
      await markUrlFailed(url, msg, MAX_RETRIES + 1);
      await writeIntakeLog({ url, stage: 'failed_exhausted', duration_ms: 0, error: msg });
    }
    return { url, status: 'error', error: msg, attempts: MAX_RETRIES + 1 };
  }
}

async function writeBatchSummary(
  total: number,
  successCount: number,
  errorCount: number,
  skippedCount: number,
): Promise<void> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL ?? process.env.SUPABASE_PITSTOP_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY ?? process.env.SUPABASE_PITSTOP_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) return;
  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  // Batch summary snapshot
  await sb.from('context_snapshots').insert({
    snapshot_type: 'batch_processing_log',
    content: {
      type: 'batch_processing_log',
      total,
      success: successCount,
      error: errorCount,
      skipped: skippedCount,
      date: new Date().toISOString(),
    },
  }).then(({ error }) => {
    if (error) console.warn('[batch] context_snapshot insert failed:', error.message);
    else console.log('[batch] batch_processing_log snapshot written');
  });

  // Notification via agent_events
  if (successCount > 0) {
    await sb.from('agent_events').insert({
      event_type: 'batch_complete',
      details: { total, success: successCount, error: errorCount, skipped: skippedCount },
    }).then(({ error }) => {
      if (error) console.warn('[batch] agent_events insert failed:', error.message);
    });
  }
}

/** POST /process/batch — parallel batch processing with retry. Up to 10 URLs. 10 req/min. */
app.post('/process/batch', processLimiter, async (req: Request, res: Response) => {
  const { urls, source_type: bodySourceType } = req.body as { urls?: unknown; source_type?: string };

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ success: false, error: 'urls[] required' });
    return;
  }
  if (urls.length > 10) {
    res.status(400).json({ success: false, error: 'Maximum 10 URLs per batch' });
    return;
  }

  const urlList = urls as string[];

  const settled = await Promise.allSettled(
    urlList.map(async (url) => {
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        // 4xx — no retry, no snapshot
        return { url, status: 'error' as const, error: 'Invalid URL' };
      }
      const source = detectSource(url, bodySourceType);
      const r = await processBatchUrl(url, source);
      // Write error snapshot for failed/skipped (success is written inside runPipeline)
      if (r.status === 'error') {
        writeContextSnapshot(url, source, 0, 0, { knowledge_items: [], summary: '', overall_immediate: 0, overall_strategic: 0, priority_signal: false, priority_reason: '', category: 'error', language: 'other' }, Date.now(), r.error).catch(() => {});
      }
      return r;
    })
  );

  const results = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { url: urlList[i] ?? '', status: 'error' as const, error: s.reason instanceof Error ? s.reason.message : String(s.reason) }
  );

  const successCount = results.filter(r => r.status === 'success').length;
  const skippedCount = results.filter(r => r.status === 'skipped').length;
  const errorCount   = results.filter(r => r.status === 'error').length;

  // Batch summary snapshot + notification (non-blocking)
  writeBatchSummary(urlList.length, successCount, errorCount, skippedCount).catch((e) => {
    console.warn('[batch] writeBatchSummary failed:', e instanceof Error ? e.message : String(e));
  });

  res.json({ success: true, results, summary: { success: successCount, skipped: skippedCount, errors: errorCount } });
});

const importLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Import rate limit — max 5 req/min' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/import-urls', importLimiter, async (req: Request, res: Response) => {
  const { urls } = req.body as { urls?: unknown };
  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls[] required' });
    return;
  }
  if (urls.length > 50) {
    res.status(400).json({ error: 'Maximum 50 URLs per request' });
    return;
  }

  const results: { url: string; status: string; knowledge_count?: number; error?: string }[] = [];

  for (const raw of urls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!url || !url.startsWith('http')) {
      results.push({ url, status: 'invalid', error: 'Not a valid URL' });
      continue;
    }

    const source = detectSource(url);
    try {
      const result = await fullPipeline(url, source);
      if ('duplicate' in result) {
        results.push({ url, status: 'duplicate' });
      } else if ('youtube_unavailable' in result) {
        results.push({ url, status: result._queued ? 'queued' : 'youtube_unavailable' });
      } else {
        results.push({ url, status: 'done', knowledge_count: result.analysis.knowledge_items.length });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[import-urls] failed for ${url}:`, msg);
      results.push({ url, status: 'failed', error: msg.slice(0, 200) });
    }
  }

  const done = results.filter(r => r.status === 'done').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const duplicates = results.filter(r => r.status === 'duplicate').length;

  console.log(`[import-urls] ${urls.length} URLs: ${done} done, ${failed} failed, ${duplicates} duplicates`);
  res.json({ processed: done, failed, duplicates, total: urls.length, results });
});

// Universal ingest endpoint — accepts pre-extracted data from Runner/external sources
app.post('/ingest-result', async (req: Request, res: Response) => {
  const { source_url, source_type, extraction } = req.body as {
    source_url?: string;
    source_type?: string;
    extraction?: {
      summary?: string;
      key_insights?: string[];
      entities?: { name: string; type?: string }[];
      actionable_ideas?: string[];
      tags?: string[];
      relevance_score?: number;
    };
  };

  if (!source_url || !extraction) {
    res.status(400).json({ error: 'source_url and extraction required' });
    return;
  }

  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  // Idempotency: if this source_url was already ingested (any status), return 200 immediately
  // Prevents retry_loop from creating duplicate knowledge/ideas for the same URL
  try {
    const { createClient: mkSb } = await import('@supabase/supabase-js');
    const sb = mkSb(pitstopUrl, pitstopKey);
    const { data: existing } = await sb.from('ingested_content').select('id, processing_status').eq('source_url', source_url).limit(1);
    if (existing && existing.length > 0) {
      const row = existing[0] as { id: string; processing_status: string };
      console.log(`[ingest-result] idempotency hit — ${source_url} already ${row.processing_status} (${row.id})`);
      res.json({ status: 'idempotent', existing_id: row.id, existing_status: row.processing_status });
      return;
    }
  } catch (e) {
    console.warn('[ingest-result] idempotency check failed (continuing):', e instanceof Error ? e.message : String(e));
  }

  const score = typeof extraction.relevance_score === 'number'
    ? Math.max(0, Math.min(1, extraction.relevance_score)) : 0.5;
  const srcType = source_type ?? 'external';
  const tags = extraction.tags ?? [];
  const entityObjects = (extraction.entities ?? []).map(e => ({
    name: e.name,
    type: (['tool', 'project', 'concept', 'person'].includes(e.type ?? '') ? e.type! : 'concept') as import('./types').EntityType,
  }));

  const insights = extraction.key_insights ?? [];
  const summary = extraction.summary ?? insights.join('. ');

  // Build KnowledgeItems for the unified pipeline
  const items: KnowledgeItem[] = [];
  for (const insight of insights.slice(0, 10)) {
    if (insight.length < 10) continue;
    items.push({
      content: insight.slice(0, 2000),
      knowledge_type: 'insight',
      project: null,
      domains: tags,
      solves_need: null,
      immediate_relevance: score,
      strategic_relevance: score * 0.9,
      novelty: 0.5,
      effort: 'medium',
      has_ready_code: false,
      business_value: null,
      tags,
      entity_objects: entityObjects,
    });
  }
  // If no insights, fall back to summary
  if (items.length === 0 && summary.length > 10) {
    items.push({
      content: summary.slice(0, 2000),
      knowledge_type: 'insight',
      project: null,
      domains: tags,
      solves_need: null,
      immediate_relevance: score,
      strategic_relevance: score * 0.9,
      novelty: 0.5,
      effort: 'medium',
      has_ready_code: false,
      business_value: null,
      tags,
      entity_objects: entityObjects,
    });
  }

  const analysis: BrainAnalysis = {
    summary,
    knowledge_items: items,
    overall_immediate: score,
    overall_strategic: score * 0.9,
    priority_signal: score >= 0.8,
    priority_reason: '',
    category: srcType,
    language: 'ru',
    entities: (extraction.entities ?? []).map(e => e.name),
  };

  // Route through unified postExtractionHook (runPipeline handles knowledge, ideas, entities, WAA, source_quality)
  const contentHash = createHash('md5').update(source_url).digest('hex');
  const pipelineResult = await runPipeline(null, analysis, source_url, srcType, contentHash);

  // Mark content_discovery as done (T490 — specific to ingest-result path)
  try {
    const { createClient: mkSb } = await import('@supabase/supabase-js');
    const sb = mkSb(pitstopUrl, pitstopKey);
    await sb.from('content_discovery')
      .update({ status: 'done', processed_at: new Date().toISOString() })
      .eq('url', source_url)
      .in('status', ['pending_youtube', 'pending']);
  } catch (e) {
    logFailedAndContinue('content_discovery_update', e as Error, { source_url });
  }

  console.log(`[ingest-result] ${source_url}: pipeline done — ${pipelineResult.savedItems} knowledge, ${pipelineResult.dedupSkipped} dedup`);
  res.json({
    status: 'ingested',
    knowledge_count: pipelineResult.savedItems,
    items_to_save: pipelineResult.itemsToSave,
    dedup_skipped: pipelineResult.dedupSkipped,
  });
});

/** GET /api/rejected — list URLs rejected by pre-filter (too short, wrong language). Last 50 items. */
app.get('/api/rejected', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(pitstopUrl, pitstopKey);
  const { data, error } = await sb
    .from('intake_logs')
    .select('url, error, created_at')
    .eq('stage', 'pre_filter_skip')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({
    count: data?.length ?? 0,
    rejected: (data ?? []).map((r) => ({
      source_url: r.url,
      reason: r.error,
      created_at: r.created_at,
    })),
  });
});

/** GET /api/stats/cost — daily Haiku API cost tracker. Returns today + 7-day history.
 *  budget_warning: true when today's estimated cost exceeds $1.00 */
app.get('/api/stats/cost', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const { data, error } = await sb
    .from('context_snapshots')
    .select('content')
    .in('snapshot_type', ['llm_cost_log', 'haiku_cost_log'])
    .gte('created_at', sevenDaysAgo + 'T00:00:00.000Z')
    .order('created_at', { ascending: false })
    .limit(5000);

  if (error) { res.status(500).json({ error: error.message }); return; }

  type DayStats = { calls: number; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; cost_usd: number };
  const byDay = new Map<string, DayStats>();

  for (const row of (data ?? [])) {
    const c = row.content as { date?: string; input_tokens?: number; output_tokens?: number; cache_write_tokens?: number; cache_read_tokens?: number; cost_usd?: number };
    const day = c.date ?? today;
    const prev = byDay.get(day) ?? { calls: 0, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };
    byDay.set(day, {
      calls: prev.calls + 1,
      input_tokens: prev.input_tokens + (c.input_tokens ?? 0),
      output_tokens: prev.output_tokens + (c.output_tokens ?? 0),
      cache_write_tokens: prev.cache_write_tokens + (c.cache_write_tokens ?? 0),
      cache_read_tokens: prev.cache_read_tokens + (c.cache_read_tokens ?? 0),
      cost_usd: prev.cost_usd + (c.cost_usd ?? 0),
    });
  }

  const BUDGET_LIMIT_USD = 1.0;
  const todayStats = byDay.get(today) ?? { calls: 0, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };
  const round5 = (n: number) => Number(n.toFixed(5));

  res.json({
    today: { date: today, ...todayStats, cost_usd: round5(todayStats.cost_usd) },
    budget_warning: todayStats.cost_usd > BUDGET_LIMIT_USD,
    budget_limit_usd: BUDGET_LIMIT_USD,
    last_7_days: Object.fromEntries(
      [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, s]) => [d, { ...s, cost_usd: round5(s.cost_usd) }])
    ),
  });
});

/** GET /api/stats/extraction-quality — quality metrics over last 100 extracted_knowledge records. */
app.get('/api/stats/extraction-quality', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  const { data, error } = await sb
    .from('extracted_knowledge')
    .select('immediate_relevance, tags, entity_objects, source_url, knowledge_type, source_type, entities')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) { res.status(500).json({ error: error.message }); return; }

  const rows = (data ?? []) as {
    immediate_relevance: number | null;
    tags: string[] | null;
    entity_objects: { name: string; type: string }[] | null;
    source_url: string | null;
    knowledge_type: string | null;
    source_type: string | null;
    entities: string[] | null;
  }[];

  const n = rows.length;
  if (n === 0) { res.json({ total: 0 }); return; }

  // Core metrics
  const scores = rows.map(r => r.immediate_relevance ?? 0);
  const avgScore = scores.reduce((s, v) => s + v, 0) / n;

  const withTags = rows.filter(r => (r.tags ?? []).length > 0).length;
  const withEntities = rows.filter(r => (r.entity_objects ?? r.entities ?? []).length > 0).length;
  const withSourceUrl = rows.filter(r => !!r.source_url).length;
  const totalTags = rows.reduce((s, r) => s + (r.tags ?? []).length, 0);

  // Distributions
  const byKnowledgeType: Record<string, number> = {};
  const bySourceType: Record<string, number> = {};
  for (const r of rows) {
    const kt = r.knowledge_type ?? 'unknown';
    byKnowledgeType[kt] = (byKnowledgeType[kt] ?? 0) + 1;
    const st = r.source_type ?? 'unknown';
    bySourceType[st] = (bySourceType[st] ?? 0) + 1;
  }

  // Top 10 tags by frequency
  const tagFreq: Record<string, number> = {};
  for (const r of rows) {
    for (const tag of (r.tags ?? [])) {
      if (tag) tagFreq[tag] = (tagFreq[tag] ?? 0) + 1;
    }
  }
  const top10Tags = Object.entries(tagFreq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  const pct = (x: number) => Number(((x / n) * 100).toFixed(1));

  res.json({
    total_sampled: n,
    avg_score: Number(avgScore.toFixed(3)),
    pct_with_tags: pct(withTags),
    pct_with_entities: pct(withEntities),
    pct_with_source_url: pct(withSourceUrl),
    avg_tags_per_record: Number((totalTags / n).toFixed(2)),
    by_knowledge_type: byKnowledgeType,
    by_source_type: bySourceType,
    top10_tags: top10Tags,
  });
});

/** POST /api/ingest/telegram — batch ingest posts from a Telegram channel.
 *  Body: { channel: string, posts: [{post_id, date?, text, url?, has_file?, file_name?}] }
 *  Each post goes through full pipeline: dedup → Haiku → route → save.
 *  source_url: https://t.me/{channel}/{post_id}, source_type: telegram */
app.post('/api/ingest/telegram', processLimiter, async (req: Request, res: Response) => {
  interface TelegramPost {
    post_id: string | number;
    date?: string;
    text: string;
    url?: string;
    has_file?: boolean;
    file_name?: string;
  }
  const { channel, posts } = req.body as { channel?: string; posts?: TelegramPost[] };

  if (!channel || !Array.isArray(posts) || posts.length === 0) {
    res.status(400).json({ error: 'channel (string) and posts (array) are required' });
    return;
  }

  const MAX_POSTS = 50;
  const batch = posts.slice(0, MAX_POSTS);
  const processed: { post_id: string | number; source_url: string; knowledge_count: number }[] = [];
  const skipped: { post_id: string | number; reason: string }[] = [];
  const failed: { post_id: string | number; error: string }[] = [];

  for (const post of batch) {
    if (!post.text || post.text.trim().length < 20) {
      skipped.push({ post_id: post.post_id, reason: 'too_short' });
      continue;
    }

    const sourceUrl = post.url ?? `https://t.me/${channel}/${post.post_id}`;
    // Include file/channel info in title so it surfaces in ingested_content
    const title = post.has_file
      ? `[${channel}] #${post.post_id} 📎 ${post.file_name ?? 'file'}`
      : `[${channel}] #${post.post_id}`;

    try {
      const result = await rawTextPipeline(post.text.trim(), 'telegram', sourceUrl, title);
      if ('duplicate' in result) {
        skipped.push({ post_id: post.post_id, reason: 'duplicate' });
      } else {
        processed.push({ post_id: post.post_id, source_url: sourceUrl, knowledge_count: result.diag.savedItems });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[telegram-ingest] post ${post.post_id} failed:`, msg);
      failed.push({ post_id: post.post_id, error: msg.slice(0, 200) });
    }
  }

  const totalCost = (processed.length * 0.0002).toFixed(4);
  console.log(`[telegram-ingest] channel=${channel} processed=${processed.length} skipped=${skipped.length} failed=${failed.length} est_cost=$${totalCost}`);

  res.json({
    status: 'done',
    channel,
    processed: processed.length,
    skipped: skipped.length,
    failed: failed.length,
    estimated_cost_usd: totalCost,
    details: { processed, skipped, failed },
  });
});

/** POST /api/ingest/telegram/batch — fetch and ingest posts from multiple public Telegram channels.
 *  Scrapes t.me/s/{channel} with cheerio: .tgme_widget_message_wrap[data-post].
 *  2s pause between channels to avoid hammering t.me.
 *  Body: { channels: string[], limit?: number (default 20, max 30 per channel) }
 *  NOTE: on Vercel use limit ≤ 5 to stay within 60s; on Railway limit ≤ 20 is fine. */
app.post('/api/ingest/telegram/batch', processLimiter, async (req: Request, res: Response) => {
  const { channels, limit = 20 } = req.body as { channels?: string[]; limit?: number };

  if (!Array.isArray(channels) || channels.length === 0) {
    res.status(400).json({ error: 'channels[] required' });
    return;
  }

  const { load } = await import('cheerio');
  const postLimit = Math.min(Number(limit) || 20, 30);
  const channelResults: { channel: string; fetched: number; processed: number; skipped: number; failed: number; cost: string; error?: string }[] = [];
  let totalCostUsd = 0;

  for (let ci = 0; ci < Math.min(channels.length, 10); ci++) {
    // 2s pause between channels — don't hammer t.me
    if (ci > 0) await new Promise(r => setTimeout(r, 2000));

    const channel = channels[ci];
    let fetched = 0, chProcessed = 0, chSkipped = 0, chFailed = 0, chCostUsd = 0;

    try {
      const fetchUrl = `https://t.me/s/${channel}`;
      const resp = await fetch(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!resp.ok) {
        channelResults.push({ channel, fetched: 0, processed: 0, skipped: 0, failed: 0, cost: '0.0000', error: `HTTP ${resp.status}` });
        continue;
      }

      const html = await resp.text();
      const $ = load(html);

      // Selector: .tgme_widget_message_wrap with data-post="channel/NNN"
      const posts: { post_id: string; date: string; text: string; url: string; has_file: boolean; file_name: string }[] = [];
      $('.tgme_widget_message_wrap[data-post]').each((_, el) => {
        const dataPost = $(el).attr('data-post') ?? '';
        const postId = dataPost.split('/').pop() ?? '';
        if (!postId) return;

        const text = $(el).find('.tgme_widget_message_text').text().replace(/\s+/g, ' ').trim();
        if (!text || text.length < 20) return;

        const date = $(el).find('time[datetime]').attr('datetime') ?? new Date().toISOString();
        const fileEl = $(el).find('.tgme_widget_message_document');
        const hasFile = fileEl.length > 0;
        const fileName = fileEl.find('.tgme_widget_message_document_title').text().trim();

        posts.push({ post_id: postId, date, text, url: `https://t.me/${channel}/${postId}`, has_file: hasFile, file_name: fileName });
      });

      // Take the last N (most recent — Telegram renders oldest-first in HTML)
      fetched = posts.length;
      const toProcess = posts.slice(-postLimit);
      console.log(`[tg-batch] ${channel}: fetched ${fetched} posts, processing ${toProcess.length}`);

      for (const post of toProcess) {
        const title = post.has_file
          ? `[${channel}] #${post.post_id} 📎 ${post.file_name || 'file'}`
          : `[${channel}] #${post.post_id}`;
        try {
          const result = await rawTextPipeline(post.text, 'telegram', post.url, title);
          if ('duplicate' in result) {
            chSkipped++;
          } else {
            chProcessed++;
            chCostUsd += 0.0002;
          }
        } catch (e) {
          chFailed++;
          console.error(`[tg-batch] ${channel}/${post.post_id}:`, e instanceof Error ? e.message : String(e));
        }
      }

      totalCostUsd += chCostUsd;
      channelResults.push({ channel, fetched, processed: chProcessed, skipped: chSkipped, failed: chFailed, cost: chCostUsd.toFixed(4) });
      console.log(`[tg-batch] ${channel}: processed=${chProcessed} skipped=${chSkipped} failed=${chFailed} cost=$${chCostUsd.toFixed(4)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[tg-batch] "${channel}" failed:`, msg);
      channelResults.push({ channel, fetched, processed: chProcessed, skipped: chSkipped, failed: chFailed, cost: chCostUsd.toFixed(4), error: msg.slice(0, 200) });
    }
  }

  res.json({
    status: 'done',
    results: channelResults,
    total_processed: channelResults.reduce((s, r) => s + r.processed, 0),
    total_cost: Number(totalCostUsd.toFixed(4)),
  });
});

/** GET /stats — processing statistics: today count, totals, uptime. */
app.get('/stats', async (_req: Request, res: Response) => {
  const { createClient } = await import('@supabase/supabase-js');

  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const memoryUrl = process.env.MEMORY_SUPABASE_URL;
  const memoryKey = process.env.MEMORY_SUPABASE_ANON_KEY;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let processed_today = 0;
  let total_processed = 0;
  let knowledge_items = 0;
  let memory_entries = 0;

  try {
    if (pitstopUrl && pitstopKey) {
      const pitstop = createClient(pitstopUrl, pitstopKey);
      const [{ count: todayCount }, { count: totalCount }, { count: knowledgeCount }] =
        await Promise.all([
          pitstop
            .from('ingested_content')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', today.toISOString()),
          pitstop.from('ingested_content').select('*', { count: 'exact', head: true }),
          pitstop.from('extracted_knowledge').select('*', { count: 'exact', head: true }),
        ]);
      processed_today = todayCount ?? 0;
      total_processed = totalCount ?? 0;
      knowledge_items = knowledgeCount ?? 0;
    }
  } catch (err) {
    console.error('[/stats] pitstop query failed:', err);
  }

  try {
    if (memoryUrl && memoryKey) {
      const memory = createClient(memoryUrl, memoryKey);
      const { count } = await memory.from('memories').select('*', { count: 'exact', head: true });
      memory_entries = count ?? 0;
    }
  } catch (err) {
    console.error('[/stats] memory query failed:', err);
  }

  res.json({
    processed_today,
    total_processed,
    knowledge_items,
    memory_entries,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

/** GET /dashboard — Pitstop Dashboard single-endpoint summary. */
app.get('/dashboard', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  const sb = createClient(pitstopUrl, pitstopKey);

  const [
    { count: knowledge_count },
    { count: ideas_count },
    { count: entities_count },
    { count: pending_discovery },
    { data: recent_knowledge },
  ] = await Promise.all([
    sb.from('extracted_knowledge').select('*', { count: 'exact', head: true }),
    sb.from('ideas').select('*', { count: 'exact', head: true }),
    sb.from('entity_nodes').select('*', { count: 'exact', head: true }),
    sb.from('content_discovery').select('*', { count: 'exact', head: true }).eq('processing_status', 'pending'),
    sb.from('extracted_knowledge').select('id,title,score,source_url,created_at').order('score', { ascending: false }).limit(5),
  ]);

  res.json({
    knowledge_count: knowledge_count ?? 0,
    ideas_count: ideas_count ?? 0,
    entities_count: entities_count ?? 0,
    pending_discovery: pending_discovery ?? 0,
    recent_knowledge: recent_knowledge ?? [],
  });
});

/** POST /process-batch-rss — process pending RSS entries. Body: { limit? } (default 10). */
app.post('/process-batch-rss', processLimiter, async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  const sb = createClient(pitstopUrl, pitstopKey);
  const limit = Math.min(Number(req.body?.limit) || 10, 20);

  const { data: pending, error } = await sb
    .from('content_discovery')
    .select('id,url,title')
    .ilike('source', 'rss:%')
    .eq('processing_status', 'pending')
    .limit(limit);

  if (error) { res.status(500).json({ error: String(error) }); return; }
  if (!pending || pending.length === 0) { res.json({ processed: 0, failed: 0, remaining: 0 }); return; }

  let processed = 0;
  let failed = 0;
  for (const entry of pending as { id: string; url: string; title: string | null }[]) {
    try {
      const source: Source = detectSource(entry.url);
      const result = await fullPipeline(entry.url, source);
      const status = ('duplicate' in result || 'youtube_unavailable' in result) ? 'skipped' : 'processed';
      if (status === 'processed') processed++;
      await sb.from('content_discovery').update({ processing_status: status }).eq('id', entry.id);
    } catch (e) {
      console.error(`[process-batch-rss] failed ${entry.url}:`, e instanceof Error ? e.message : String(e));
      await sb.from('content_discovery').update({ processing_status: 'failed' }).eq('id', entry.id);
      failed++;
    }
  }

  const { count } = await sb
    .from('content_discovery')
    .select('id', { count: 'exact', head: true })
    .ilike('source', 'rss:%')
    .eq('processing_status', 'pending');

  res.json({ processed, failed, remaining: count ?? 0 });
});

/** GET /content-pipeline-status — full pipeline status snapshot. */
app.get('/content-pipeline-status', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  const sb = createClient(pitstopUrl, pitstopKey);

  const [
    { data: ingestedCounts },
    { data: discoveryCounts },
    { count: knowledgeTotal },
    { data: knowledgeScores },
    { count: entityNodes },
    { count: entityEdges },
    { data: feedStats },
  ] = await Promise.all([
    sb.from('ingested_content').select('processing_status').then(async (r) => {
      const rows = (r.data ?? []) as { processing_status: string }[];
      const counts = { done: 0, processing: 0, failed: 0, quarantined: 0 };
      for (const row of rows) {
        const s = row.processing_status as keyof typeof counts;
        if (s in counts) counts[s]++;
      }
      return { data: counts };
    }),
    sb.from('content_discovery').select('processing_status').then(async (r) => {
      const rows = (r.data ?? []) as { processing_status: string }[];
      const counts = { pending: 0, done: 0, failed: 0 };
      for (const row of rows) {
        const s = row.processing_status as keyof typeof counts;
        if (s in counts) counts[s]++;
      }
      return { data: counts };
    }),
    sb.from('extracted_knowledge').select('*', { count: 'exact', head: true }),
    sb.from('extracted_knowledge').select('score').not('score', 'is', null).limit(500),
    sb.from('entity_nodes').select('*', { count: 'exact', head: true }),
    sb.from('entity_edges').select('*', { count: 'exact', head: true }),
    sb.from('rss_feeds').select('last_checked').order('last_checked', { ascending: false }).limit(1),
  ]);

  const scores = (knowledgeScores ?? []) as { score: number }[];
  const avg_score = scores.length > 0
    ? Math.round((scores.reduce((s, r) => s + (r.score ?? 0), 0) / scores.length) * 100) / 100
    : 0;

  res.json({
    ingested_content: ingestedCounts ?? {},
    content_discovery: discoveryCounts ?? {},
    extracted_knowledge: { total: knowledgeTotal ?? 0, avg_score },
    entity_nodes: { total: entityNodes ?? 0 },
    entity_edges: { total: entityEdges ?? 0 },
    rss_feeds: { last_check: feedStats?.[0]?.last_checked ?? null },
  });
});

/** DELETE /cleanup-stale — mark stuck processing records as failed. */
app.delete('/cleanup-stale', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  const sb = createClient(pitstopUrl, pitstopKey);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('ingested_content')
    .update({ processing_status: 'failed' })
    .eq('processing_status', 'processing')
    .lt('created_at', oneHourAgo)
    .select('id');

  if (error) { res.status(500).json({ error: (error as { message?: string }).message ?? JSON.stringify(error) }); return; }
  res.json({ cleaned: data?.length ?? 0 });
});

/** POST /reprocess-failed — reprocess failed ingested_content records. */
app.post('/reprocess-failed', processLimiter, async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  const sb = createClient(pitstopUrl, pitstopKey);

  const { data: failed, error } = await sb
    .from('ingested_content')
    .select('id,source_url')
    .eq('processing_status', 'failed')
    .limit(5);

  if (error) { res.status(500).json({ error: String(error) }); return; }
  if (!failed || failed.length === 0) { res.json({ results: [], total: 0 }); return; }

  const results: { url: string; status: string }[] = [];
  for (const entry of failed as { id: string; source_url: string }[]) {
    try {
      await sb.from('ingested_content').update({ processing_status: 'processing' }).eq('id', entry.id);
      const source: Source = detectSource(entry.source_url);
      const result = await fullPipeline(entry.source_url, source);
      if ('duplicate' in result) {
        results.push({ url: entry.source_url, status: 'duplicate' });
        await sb.from('ingested_content').update({ processing_status: 'done' }).eq('id', entry.id);
      } else if ('youtube_unavailable' in result) {
        results.push({ url: entry.source_url, status: 'youtube_unavailable' });
        await sb.from('ingested_content').update({ processing_status: 'failed' }).eq('id', entry.id);
      } else {
        results.push({ url: entry.source_url, status: 'success' });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ url: entry.source_url, status: `error: ${msg.slice(0, 100)}` });
      await sb.from('ingested_content').update({ processing_status: 'failed' }).eq('id', entry.id);
    }
  }

  res.json({ results, total: results.length });
});

interface SummarizeBody {
  text: string;
  maxLength?: number;
}

/** POST /summarize — summarize text without saving to DB. Uses Haiku. Body: { text, maxLength? }. */
app.post('/summarize', async (req: Request, res: Response) => {
  const { text, maxLength } = req.body as SummarizeBody;

  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const truncated = text.length > 10000 ? text.slice(0, 10000) : text;
  const words = maxLength ?? 200;

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  // API Cost Protection: max 1 retry. See incident 29.03.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });

  try {
    console.log(`[INTAKE] Haiku summarize call: max_tokens=1024, text_len=${truncated.length}`);
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Суммаризируй текст в ${words} слов. Верни JSON: { "summary": string, "keyPoints": string[] } — только JSON без markdown\n\n${truncated}`,
        },
      ],
    });

    const raw = message.content[0].type === 'text' ? message.content[0].text : '';
    console.log(`[INTAKE] Haiku summarize done: in=${message.usage?.input_tokens ?? 0} out=${message.usage?.output_tokens ?? 0}`);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in Haiku response: ' + raw.substring(0, 100));
    const parsed = JSON.parse(jsonMatch[0]) as {
      summary: string;
      keyPoints: string[];
    };

    res.json(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/summarize] error:', message);
    res.status(500).json({ error: message });
  }
});

/** POST /backfill-embeddings — generate missing OpenAI embeddings (512 dim). 10 rows per call. */
app.post('/backfill-embeddings', async (_req: Request, res: Response) => {
  const { createClient } = await import('@supabase/supabase-js');
  const OpenAI = (await import('openai')).default;

  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!pitstopUrl || !pitstopKey || !openaiKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const supabase = createClient(pitstopUrl, pitstopKey);
  const openai = new OpenAI({ apiKey: openaiKey });

  const { data: rows, error } = await supabase
    .from('extracted_knowledge')
    .select('id, content')
    .is('embedding', null)
    .limit(10);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (!rows || rows.length === 0) {
    const { count } = await supabase
      .from('extracted_knowledge')
      .select('*', { count: 'exact', head: true })
      .is('embedding', null);
    res.json({ processed: 0, remaining: count ?? 0 });
    return;
  }

  let processed = 0;
  for (const row of rows as { id: string; content: string }[]) {
    try {
      const resp = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: row.content.slice(0, 8000),
        dimensions: 512,
      });
      const { error: upErr } = await supabase
        .from('extracted_knowledge')
        .update({ embedding: resp.data[0].embedding })
        .eq('id', row.id);
      if (!upErr) processed++;
    } catch (e) {
      console.error('[backfill] row', row.id, e instanceof Error ? e.message : String(e));
    }
  }

  const { count: remaining } = await supabase
    .from('extracted_knowledge')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null);

  res.json({ processed, remaining: remaining ?? 0 });
});

/** GET /quality-report — scoring distribution audit. Random sample + aggregate stats. */
app.get('/quality-report', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(pitstopUrl, pitstopKey);

  const { count: totalCount } = await supabase
    .from('extracted_knowledge')
    .select('*', { count: 'exact', head: true });
  const total = totalCount ?? 0;
  const offset = total > 20 ? Math.floor(Math.random() * (total - 20)) : 0;

  const { data: sample, error: sampleErr } = await supabase
    .from('extracted_knowledge')
    .select('id, content, immediate_relevance, strategic_relevance, knowledge_type, created_at, entities')
    .order('created_at', { ascending: false })
    .range(offset, offset + 19);

  if (sampleErr) {
    res.status(500).json({ error: sampleErr.message });
    return;
  }

  const { data: allScores } = await supabase
    .from('extracted_knowledge')
    .select('immediate_relevance, strategic_relevance');

  const scores = (allScores ?? []) as { immediate_relevance: number; strategic_relevance: number }[];
  const hot = scores.filter((s) => s.immediate_relevance >= 0.7).length;
  const mid = scores.filter((s) => s.immediate_relevance >= 0.4 && s.immediate_relevance < 0.7).length;
  const low = scores.filter((s) => s.immediate_relevance < 0.4).length;
  const avgImmediate = scores.length > 0 ? scores.reduce((a, s) => a + s.immediate_relevance, 0) / scores.length : 0;
  const avgStrategic = scores.length > 0 ? scores.reduce((a, s) => a + s.strategic_relevance, 0) / scores.length : 0;
  const highStrategic = scores.filter((s) => s.strategic_relevance >= 0.7).length;

  res.json({
    total_records: total,
    sample_offset: offset,
    sample: sample ?? [],
    stats: {
      hot_count: hot,
      mid_count: mid,
      low_count: low,
      avg_immediate: parseFloat(avgImmediate.toFixed(3)),
      avg_strategic: parseFloat(avgStrategic.toFixed(3)),
      high_strategic_count: highStrategic,
      hot_pct: scores.length > 0 ? parseFloat((hot / scores.length * 100).toFixed(1)) : 0,
    },
  });
});

// Export extracted_knowledge as JSON or CSV for analysis in Excel/NotebookLM
app.get('/export-knowledge', async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const format = (req.query.format as string) === 'csv' ? 'csv' : 'json';
  const minScore = Math.max(0, Math.min(1, Number(req.query.min_score ?? 0)));
  const limit = Math.min(Number(req.query.limit ?? 1000), 5000);
  const days = Math.min(Number(req.query.days ?? 30), 365);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  const { data: rows, error: fetchErr } = await sb
    .from('extracted_knowledge')
    .select('content, knowledge_type, immediate_relevance, strategic_relevance, entities, entity_objects, tags, source_url, source_type, created_at')
    .gte('immediate_relevance', minScore)
    .gte('created_at', cutoff)
    .order('immediate_relevance', { ascending: false })
    .limit(limit);

  if (fetchErr) {
    res.status(500).json({ error: fetchErr.message });
    return;
  }

  const items = (rows ?? []) as {
    content: string; knowledge_type: string; immediate_relevance: number; strategic_relevance: number;
    entities: string[] | null; entity_objects: { name: string; type: string }[] | null;
    tags: string[] | null; source_url: string; source_type: string; created_at: string;
  }[];

  if (format === 'csv') {
    // Manual CSV — no extra dependency
    const escCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = 'content,knowledge_type,immediate_relevance,strategic_relevance,entities,tags,source_url,source_type,created_at';
    const csvRows = items.map(r => [
      escCsv(r.content),
      r.knowledge_type,
      r.immediate_relevance.toFixed(3),
      r.strategic_relevance.toFixed(3),
      escCsv((r.entities ?? r.tags ?? []).join('; ')),
      escCsv((r.tags ?? []).join('; ')),
      escCsv(r.source_url ?? ''),
      r.source_type ?? '',
      r.created_at,
    ].join(','));

    const csv = header + '\n' + csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="knowledge_export_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel compatibility
  } else {
    res.json({
      count: items.length,
      filters: { min_score: minScore, days, limit },
      items: items.map(r => ({
        content: r.content,
        type: r.knowledge_type,
        score: r.immediate_relevance,
        strategic: r.strategic_relevance,
        entities: r.entities ?? r.tags ?? [],
        entity_objects: r.entity_objects ?? [],
        source_url: r.source_url,
        source_type: r.source_type,
        created_at: r.created_at,
      })),
    });
  }
});

app.post('/analyze-trends', async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Supabase not configured' });
    return;
  }

  const days = Math.min(Number(req.body?.days ?? 7), 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const { createClient: mk } = await import('@supabase/supabase-js');
    const sb = mk(pitstopUrl, pitstopKey);

    // 1) Trending tags — aggregate from tags[] column within period
    const { data: tagRows, error: tagErr } = await sb
      .from('extracted_knowledge')
      .select('tags')
      .gte('created_at', cutoff);
    if (tagErr) throw tagErr;

    const tagCounts = new Map<string, number>();
    for (const row of tagRows ?? []) {
      for (const tag of (row.tags as string[]) ?? []) {
        if (tag && tag.length >= 2) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const trending_tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));

    // 2) Hot knowledge — top scoring items in period
    const { data: hotRows, error: hotErr } = await sb
      .from('extracted_knowledge')
      .select('content, immediate_relevance, strategic_relevance, entities, source_url, source_type, created_at')
      .gte('created_at', cutoff)
      .order('immediate_relevance', { ascending: false })
      .limit(10);
    if (hotErr) throw hotErr;

    const hot_knowledge = (hotRows ?? []).map((r: { content: string; immediate_relevance: number; strategic_relevance: number; entities: string[] | null; source_url: string; source_type: string; created_at: string }) => ({
      content: (r.content ?? '').slice(0, 200),
      immediate_relevance: r.immediate_relevance,
      strategic_relevance: r.strategic_relevance,
      entities: r.entities ?? [],
      source_url: r.source_url,
      source_type: r.source_type,
      created_at: r.created_at,
    }));

    // 3) Source type breakdown
    const sourceTypeCounts = new Map<string, number>();
    for (const row of tagRows ?? []) {
      // tagRows only has tags, need separate query
    }
    const { data: sourceRows } = await sb
      .from('extracted_knowledge')
      .select('source_type')
      .gte('created_at', cutoff);
    for (const row of sourceRows ?? []) {
      const st = (row.source_type as string) ?? 'unknown';
      sourceTypeCounts.set(st, (sourceTypeCounts.get(st) ?? 0) + 1);
    }
    const source_breakdown = [...sourceTypeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([source_type, count]) => ({ source_type, count }));

    // 4) Entity leaderboard from entity_nodes
    const { data: topEntities } = await sb
      .from('entity_nodes')
      .select('name, type, mention_count')
      .order('mention_count', { ascending: false })
      .limit(15);

    const entity_leaderboard = (topEntities ?? []).map((e: { name: string; type: string; mention_count: number }) => ({
      name: e.name,
      type: e.type,
      mentions: e.mention_count,
    }));

    // 5) Period stats
    const totalInPeriod = (tagRows ?? []).length;
    const avgScore = hot_knowledge.length > 0
      ? hot_knowledge.reduce((s, r) => s + r.immediate_relevance, 0) / hot_knowledge.length : 0;

    res.json({
      period: { days, from: cutoff, to: new Date().toISOString() },
      total_knowledge: totalInPeriod,
      avg_top10_score: +avgScore.toFixed(3),
      trending_tags,
      hot_knowledge,
      source_breakdown,
      entity_leaderboard,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/analyze-trends] error:', message);
    res.status(500).json({ error: message });
  }
});

async function runEntityBackfill(): Promise<{ processed: number; remaining: number }> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!pitstopUrl || !pitstopKey || !anthropicKey) return { processed: 0, remaining: 0 };

  const { createClient: mkSupabase } = await import('@supabase/supabase-js');
  const AnthropicSDK = (await import('@anthropic-ai/sdk')).default;
  const supabase = mkSupabase(pitstopUrl, pitstopKey);
  // API Cost Protection: max 1 retry. See incident 29.03.
  const anthropic = new AnthropicSDK({ apiKey: anthropicKey, maxRetries: 1 });

  // Match both NULL and empty array for entity_objects
  const { data: rows, error } = await supabase
    .from('extracted_knowledge')
    .select('id, content')
    .or('entity_objects.is.null,entity_objects.eq.[]')
    .limit(10);

  if (error || !rows || rows.length === 0) {
    const { count } = await supabase
      .from('extracted_knowledge')
      .select('*', { count: 'exact', head: true })
      .or('entity_objects.is.null,entity_objects.eq.[]');
    return { processed: 0, remaining: count ?? 0 };
  }

  let processed = 0;
  for (const row of rows as { id: string; content: string }[]) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Extract named entities from this text. For each, classify as tool, project, concept, or person. Return ONLY JSON: {"e":["Name1","Name2"],"eo":[{"n":"Name1","t":"tool"}]}\n\n${row.content.slice(0, 500)}`,
        }],
      });
      const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '{}';
      const objMatch = raw.match(/\{[\s\S]*?\}/);
      if (objMatch) {
        try {
          const parsed = JSON.parse(objMatch[0]) as { e?: string[]; eo?: { n: string; t: string }[] };
          const entities = parsed.e ?? [];
          const entity_objects = (parsed.eo ?? []).map((o) => ({
            name: o.n,
            type: ['tool', 'project', 'concept', 'person'].includes(o.t) ? o.t : 'concept',
          }));
          const { error: upErr } = await supabase
            .from('extracted_knowledge')
            .update({ entities, entity_objects })
            .eq('id', row.id);
          if (!upErr) processed++;
        } catch { /* skip malformed */ }
      }
    } catch (e) {
      console.error('[backfill-entities] row', row.id, e instanceof Error ? e.message : String(e));
    }
  }

  const { count: remaining } = await supabase
    .from('extracted_knowledge')
    .select('*', { count: 'exact', head: true })
    .or('entity_objects.is.null,entity_objects.eq.[]');

  return { processed, remaining: remaining ?? 0 };
}

/** POST /backfill-entities — extract entity graph from knowledge via Haiku. 10 rows per call. */
app.post('/backfill-entities', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!pitstopUrl || !pitstopKey || !anthropicKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }
  const result = await runEntityBackfill();
  res.json(result);
});

/** POST /backfill-edge-types — replace co_occurs edges with inferred relationship types. */
app.post('/backfill-edge-types', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  // Fetch all co_occurs edges
  const { data: edges, error: fetchErr } = await sb
    .from('entity_edges')
    .select('id, source_id, target_id, relationship')
    .eq('relationship', 'co_occurs');

  if (fetchErr || !edges || edges.length === 0) {
    res.json({ updated: 0, total_co_occurs: 0 });
    return;
  }

  // Fetch all nodes for type lookup
  const nodeIds = new Set<string>();
  for (const e of edges) {
    nodeIds.add(e.source_id as string);
    nodeIds.add(e.target_id as string);
  }
  const { data: nodes } = await sb
    .from('entity_nodes')
    .select('id, type')
    .in('id', [...nodeIds]);

  const typeById = new Map<string, string>();
  for (const n of (nodes ?? [])) {
    typeById.set(n.id as string, (n.type as string) ?? 'concept');
  }

  // Infer relationship rules: tool+tool→competes_with, person+tool→uses, tool+concept→implements, default→related_to
  function infer(srcType: string, tgtType: string): string {
    const key = `${srcType}+${tgtType}`;
    switch (key) {
      case 'tool+tool': return 'competes_with';
      case 'person+tool': return 'uses';
      case 'tool+person': return 'created_by';
      case 'tool+concept': return 'implements';
      case 'concept+tool': return 'implements';
      case 'person+project': return 'created_by';
      case 'project+tool': return 'built_with';
      case 'tool+project': return 'built_with';
      default: return 'related_to';
    }
  }

  let updated = 0;
  for (const edge of edges) {
    const srcType = typeById.get(edge.source_id as string) ?? 'concept';
    const tgtType = typeById.get(edge.target_id as string) ?? 'concept';
    const newRel = infer(srcType, tgtType);

    const { error: upErr } = await sb
      .from('entity_edges')
      .update({ relationship: newRel })
      .eq('id', edge.id);

    if (!upErr) updated++;
  }

  console.log(`[backfill-edge-types] updated ${updated}/${edges.length} edges from co_occurs`);
  res.json({ updated, total_co_occurs: edges.length });
});

/** POST /label-clusters — auto-label knowledge clusters via keyword frequency. Zero LLM cost. */
app.post('/label-clusters', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  // Fetch clusters: group by cluster_id, collect content ordered by score
  const { data: rows, error: fetchErr } = await sb
    .from('extracted_knowledge')
    .select('cluster_id, content, immediate_relevance')
    .not('cluster_id', 'is', null)
    .order('immediate_relevance', { ascending: false });

  if (fetchErr || !rows || rows.length === 0) {
    res.json({ labeled: 0, clusters: [] });
    return;
  }

  // Group by cluster_id
  const clusters = new Map<string, string[]>();
  for (const row of rows) {
    const cid = String(row.cluster_id);
    if (!clusters.has(cid)) clusters.set(cid, []);
    clusters.get(cid)!.push(row.content as string);
  }

  // Stopwords (ru + en) for keyword extraction
  const STOPWORDS = new Set([
    // Russian
    'и', 'в', 'на', 'с', 'по', 'для', 'из', 'к', 'от', 'до', 'не', 'что', 'как',
    'это', 'при', 'все', 'уже', 'его', 'или', 'но', 'то', 'так', 'бы', 'же',
    'об', 'без', 'за', 'их', 'ещё', 'через', 'может', 'можно', 'также', 'более',
    'между', 'после', 'перед', 'только', 'будет', 'были', 'быть', 'был', 'была',
    'который', 'которые', 'которая', 'которое', 'этот', 'эта', 'эти',
    // English
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
    'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only',
    'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
    'if', 'while', 'about', 'up', 'that', 'this', 'it', 'its', 'they', 'them',
    'their', 'what', 'which', 'who', 'whom', 'these', 'those', 'am',
    'using', 'use', 'used', 'new', 'like', 'also', 'one', 'two',
  ]);

  // Extract top-3 keywords from cluster content via word frequency
  function extractKeywords(texts: string[]): string {
    const top5 = texts.slice(0, 5);
    const freq = new Map<string, number>();

    for (const text of top5) {
      // Extract words 3+ chars, skip stopwords
      const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/);
      const seen = new Set<string>(); // count each word once per text (TF-IDF-like)
      for (const w of words) {
        if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }

    // Sort by frequency desc, take top 3
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const keywords = sorted.slice(0, 3).map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));
    return keywords.join(', ') || 'Uncategorized';
  }

  const results: { cluster_id: string; label: string; count: number }[] = [];

  for (const [cid, contents] of clusters) {
    const label = extractKeywords(contents);
    const count = contents.length;

    // Upsert to knowledge_clusters
    const { error: upsErr } = await sb
      .from('knowledge_clusters')
      .upsert({ cluster_id: cid, label, count, updated_at: new Date().toISOString() }, { onConflict: 'cluster_id' });

    if (upsErr) {
      console.error(`[label-clusters] upsert failed for cluster ${cid}:`, upsErr.message);
    } else {
      results.push({ cluster_id: cid, label, count });
    }
  }

  console.log(`[label-clusters] labeled ${results.length} clusters`);
  res.json({ labeled: results.length, clusters: results });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAutoDiscover(topics: string[], supabase: any): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const topic of topics) {
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(topic)}&sp=CAI`;
      const jinaResp = await fetch('https://r.jina.ai/' + searchUrl, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(15000),
      });
      if (!jinaResp.ok) { counts[topic] = 0; continue; }
      const text = await jinaResp.text();

      // Extract YouTube video URLs and titles from Jina plain-text output
      // Lines look like: [Title](https://www.youtube.com/watch?v=xxx)
      const linkRegex = /\[([^\]]+)\]\((https:\/\/www\.youtube\.com\/watch\?v=[^)]+)\)/g;
      const rows: { url: string; title: string; source: string; topic: string; status: string }[] = [];
      let match: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((match = linkRegex.exec(text)) !== null && rows.length < 10) {
        const title = match[1].trim();
        const url = match[2].trim();
        if (seen.has(url)) continue;
        seen.add(url);
        rows.push({ url, title, source: 'youtube', topic, status: 'pending' });
      }

      if (rows.length === 0) { counts[topic] = 0; continue; }

      // Upsert — skip already-known URLs
      const { data: existing } = await supabase
        .from('content_discovery')
        .select('url')
        .in('url', rows.map((r) => r.url));
      const existingUrls = new Set((existing ?? []).map((r: { url: string }) => r.url));
      const newRows = rows.filter((r) => !existingUrls.has(r.url));

      if (newRows.length > 0) {
        await supabase.from('content_discovery').insert(newRows);
      }
      counts[topic] = newRows.length;
      console.log(`[auto-discover] topic="${topic}" found ${rows.length}, inserted ${newRows.length} new`);
    } catch (e) {
      console.error(`[auto-discover] topic="${topic}" failed:`, e instanceof Error ? e.message : String(e));
      counts[topic] = 0;
    }
  }

  return counts;
}

interface AutoDiscoverBody { topics: string[] }

/** POST /auto-discover — discover new content by topics via YouTube search. Body: { topics[] }. Max 10. */
app.post('/auto-discover', async (req: Request, res: Response) => {
  const { topics } = req.body as AutoDiscoverBody;
  if (!Array.isArray(topics) || topics.length === 0) {
    res.status(400).json({ error: 'topics[] required' });
    return;
  }
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }
  const { createClient: mkSupabase } = await import('@supabase/supabase-js');
  const supabase = mkSupabase(pitstopUrl, pitstopKey);
  const counts = await runAutoDiscover(topics.slice(0, 10), supabase);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ discovered: total, by_topic: counts });
});

/** POST /process-discovery — process pending content_discovery items. Body: { limit? }. 10 req/min. */
app.post('/process-discovery', processLimiter, async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const limit = Math.min(Number(req.body?.limit ?? 5), 20);

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  // Fetch pending discovery items
  const { data: pending, error: fetchErr } = await sb
    .from('content_discovery')
    .select('id, url, source, title')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (fetchErr) {
    res.status(500).json({ error: fetchErr.message });
    return;
  }
  if (!pending || pending.length === 0) {
    // Count remaining
    const { count } = await sb.from('content_discovery').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    res.json({ processed: 0, failed: 0, remaining: count ?? 0 });
    return;
  }

  let processed = 0;
  let failed = 0;
  const details: { url: string; status: string; error?: string }[] = [];

  for (const item of pending) {
    const url = item.url as string;
    const source = detectSource(url, (item.source as string) ?? undefined);

    // Mark as processing
    await sb.from('content_discovery').update({ status: 'processing' }).eq('id', item.id);

    try {
      const result = await fullPipeline(url, source);

      if ('duplicate' in result) {
        await sb.from('content_discovery').update({ status: 'duplicate' }).eq('id', item.id);
        details.push({ url, status: 'duplicate' });
      } else if ('youtube_unavailable' in result) {
        await sb.from('content_discovery').update({ status: 'failed', error: 'youtube_unavailable' }).eq('id', item.id);
        details.push({ url, status: 'youtube_unavailable' });
        failed++;
      } else {
        await sb.from('content_discovery').update({
          status: 'done',
          processed_at: new Date().toISOString(),
        }).eq('id', item.id);
        details.push({ url, status: 'done' });
        processed++;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[process-discovery] failed for ${url}:`, errMsg);
      await sb.from('content_discovery').update({ status: 'failed', error: errMsg.slice(0, 500) }).eq('id', item.id);
      details.push({ url, status: 'failed', error: errMsg.slice(0, 200) });
      failed++;
    }
  }

  // Count remaining
  const { count: remaining } = await sb.from('content_discovery').select('id', { count: 'exact', head: true }).eq('status', 'pending');

  console.log(`[process-discovery] processed=${processed} failed=${failed} remaining=${remaining ?? '?'}`);
  res.json({ processed, failed, remaining: remaining ?? 0, details });
});

// Smart Content Recommender — finds new content to read/watch based on knowledge graph
app.post('/recommend', async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const maxTopics = Math.min(Number(req.body?.max_topics ?? 5), 10);
  const perTopic = Math.min(Number(req.body?.per_topic ?? 5), 10);

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  // 1. Top topics from entity_nodes (most mentioned tools/concepts)
  const { data: topEntities, error: entErr } = await sb
    .from('entity_nodes')
    .select('name, type, mention_count')
    .in('type', ['tool', 'project', 'concept'])
    .order('mention_count', { ascending: false })
    .limit(maxTopics * 2); // fetch extra to filter generics

  if (entErr || !topEntities || topEntities.length === 0) {
    res.json({ topics: [], recommendations: [], error: entErr?.message ?? 'no entities found' });
    return;
  }

  // Filter out single-char and overly generic entities
  const GENERIC = new Set(['ai', 'api', 'ui', 'ux', 'css', 'html', 'sql', 'http', 'json', 'cli', 'sdk', 'ide']);
  const topics = (topEntities as { name: string; type: string; mention_count: number }[])
    .filter(e => e.name.length >= 2 && !GENERIC.has(e.name.toLowerCase()))
    .slice(0, maxTopics)
    .map(e => e.name);

  console.log(`[recommend] top topics: ${topics.join(', ')}`);

  // 2. Already processed URLs
  const { data: doneRows } = await sb
    .from('ingested_content')
    .select('source_url')
    .eq('processing_status', 'done');
  const processedUrls = new Set((doneRows ?? []).map((r: { source_url: string }) => r.source_url).filter(Boolean));

  // Also exclude existing content_discovery URLs
  const { data: discoveryRows } = await sb
    .from('content_discovery')
    .select('url');
  const discoveryUrls = new Set((discoveryRows ?? []).map((r: { url: string }) => r.url).filter(Boolean));

  const allKnown = new Set([...processedUrls, ...discoveryUrls]);

  // 3. Search for content per topic using quality sources via Jina Reader
  // Multi-source search: YouTube for videos, Habr/dev.to for articles
  const SEARCH_TEMPLATES = [
    { source: 'youtube', buildUrl: (topic: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(topic + ' 2025 tutorial')}&sp=CAI` },
    { source: 'habr', buildUrl: (topic: string) => `https://habr.com/ru/search/?q=${encodeURIComponent(topic)}&target_type=posts&order=date` },
    { source: 'dev.to', buildUrl: (topic: string) => `https://dev.to/search?q=${encodeURIComponent(topic)}` },
  ];

  type Recommendation = { url: string; title: string; topic: string; source: string; reason: string };
  const recommendations: Recommendation[] = [];
  const topicStats: Record<string, number> = {};

  for (const topic of topics) {
    let foundForTopic = 0;

    for (const tmpl of SEARCH_TEMPLATES) {
      if (foundForTopic >= perTopic) break;

      try {
        const searchUrl = tmpl.buildUrl(topic);
        const jinaResp = await fetch('https://r.jina.ai/' + searchUrl, {
          headers: { Accept: 'text/plain' },
          signal: AbortSignal.timeout(12000),
        });
        if (!jinaResp.ok) continue;
        const text = await jinaResp.text();

        // Extract links: [Title](URL) pattern from Jina output
        const linkRegex = /\[([^\]]{5,})\]\((https?:\/\/[^)]+)\)/g;
        let match: RegExpExecArray | null;
        while ((match = linkRegex.exec(text)) !== null && foundForTopic < perTopic) {
          const title = match[1].trim();
          const url = match[2].trim();

          // Skip known URLs, non-content links, and navigation links
          if (allKnown.has(url)) continue;
          if (url.includes('/login') || url.includes('/signup') || url.includes('/settings')) continue;
          if (url.includes('/tag/') || url.includes('/search') || url.includes('?page=')) continue;
          if (title.length < 10 || title.length > 300) continue;

          // For YouTube: only video pages
          if (tmpl.source === 'youtube' && !url.includes('watch?v=')) continue;
          // For Habr: only article pages
          if (tmpl.source === 'habr' && !url.match(/habr\.com\/ru\/(articles|post)\/\d+/)) continue;
          // For dev.to: only article pages
          if (tmpl.source === 'dev.to' && !url.match(/dev\.to\/[^/]+\/[^/]+/)) continue;

          allKnown.add(url); // prevent cross-topic duplicates
          recommendations.push({
            url,
            title: title.slice(0, 200),
            topic,
            source: tmpl.source,
            reason: `Top entity "${topic}" (${tmpl.source} search)`,
          });
          foundForTopic++;
        }
      } catch (e) {
        console.warn(`[recommend] search failed for "${topic}" on ${tmpl.source}:`, e instanceof Error ? e.message : String(e));
      }
    }

    topicStats[topic] = foundForTopic;
  }

  // 5. Save to content_discovery
  if (recommendations.length > 0) {
    const discoveryRows = recommendations.map(r => ({
      url: r.url,
      title: r.title,
      source: r.source,
      topic: r.topic,
      status: 'pending',
      discovered_by: 'auto_recommend',
    }));

    const { error: insertErr } = await sb.from('content_discovery').insert(discoveryRows);
    if (insertErr) {
      console.error('[recommend] content_discovery insert failed:', insertErr.message);
    }
  }

  // Log action
  try {
    await sb.from('agent_action_log').insert({
      agent: 'intaker', action: 'recommend', status: 'done',
      details: { topics, total: recommendations.length, by_topic: topicStats },
      repo: 'maos-intake',
    });
  } catch (e) {
    logFailedAndContinue('agent_action_log_recommend', e as Error);
  }

  console.log(`[recommend] ${recommendations.length} recommendations across ${topics.length} topics`);
  res.json({
    topics,
    recommendations,
    by_topic: topicStats,
    total: recommendations.length,
    saved_to_discovery: recommendations.length,
  });
});

// ── RSS/Atom Feed Aggregator ──────────────────────────────────────────────────

const SEED_FEEDS: { url: string; title: string; source_type: string }[] = [
  { url: 'https://habr.com/ru/rss/flows/develop/all/', title: 'Habr Dev', source_type: 'blog' },
  { url: 'https://dev.to/feed', title: 'DEV Community', source_type: 'blog' },
  { url: 'https://simonwillison.net/atom/everything/', title: 'Simon Willison', source_type: 'blog' },
  { url: 'https://lilianweng.github.io/index.xml', title: 'Lilian Weng', source_type: 'blog' },
  { url: 'https://openai.com/blog/rss.xml', title: 'OpenAI Blog', source_type: 'news' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw', title: 'Google DeepMind', source_type: 'youtube' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg', title: 'Two Minute Papers', source_type: 'youtube' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCWN3xxRkmTPphiiT1p3x9zw', title: 'Fireship', source_type: 'youtube' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA', title: 'Fireship Alt', source_type: 'youtube' },
];

app.post('/add-feed', async (req: Request, res: Response) => {
  const { url, title, source_type } = req.body as { url?: string; title?: string; source_type?: string };
  if (!url) {
    res.status(400).json({ error: 'url required' });
    return;
  }
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  const validTypes = ['youtube', 'blog', 'news', 'newsletter'];
  const row = {
    url: url.trim(),
    title: title ?? null,
    source_type: validTypes.includes(source_type ?? '') ? source_type : 'blog',
    active: true,
    check_interval_hours: 6,
    total_entries_found: 0,
    total_processed: 0,
  };

  const { data, error } = await sb.from('rss_feeds').insert(row).select().single();
  if (error) {
    res.status(error.code === '23505' ? 409 : 500).json({ error: error.message });
    return;
  }
  res.json({ feed: data });
});

app.get('/feeds', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  const { data, error } = await sb.from('rss_feeds').select('*').order('last_checked', { ascending: false, nullsFirst: true });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ feeds: data ?? [], count: (data ?? []).length });
});

app.get('/check-feeds', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);
  const { default: RSSParser } = await import('rss-parser');
  const parser = new RSSParser({ timeout: 10000 });

  // Seed if empty
  const { count: feedCount } = await sb.from('rss_feeds').select('id', { count: 'exact', head: true });
  if ((feedCount ?? 0) === 0) {
    console.log('[rss] seeding default feeds');
    const seedRows = SEED_FEEDS.map(f => ({
      ...f, active: true, check_interval_hours: 6, total_entries_found: 0, total_processed: 0,
    }));
    await sb.from('rss_feeds').insert(seedRows);
  }

  // Fetch feeds due for check
  const { data: feeds, error: fetchErr } = await sb
    .from('rss_feeds')
    .select('*')
    .eq('active', true)
    .or('last_checked.is.null,last_checked.lt.' + new Date(Date.now() - 3600000).toISOString());

  if (fetchErr || !feeds || feeds.length === 0) {
    res.json({ feeds_checked: 0, new_entries_total: 0 });
    return;
  }

  // Filter by check_interval_hours (the .or above uses 1h minimum, refine here)
  const now = Date.now();
  const dueFeeds = feeds.filter(f => {
    if (!f.last_checked) return true;
    const interval = ((f.check_interval_hours as number) ?? 6) * 3600000;
    return now - new Date(f.last_checked as string).getTime() >= interval;
  });

  let feedsChecked = 0;
  let newEntriesTotal = 0;
  const details: { feed: string; new_entries: number; error?: string }[] = [];

  for (const feed of dueFeeds) {
    const feedUrl = feed.url as string;
    const feedTitle = (feed.title as string) ?? feedUrl;
    const lastEntryDate = feed.last_entry_date ? new Date(feed.last_entry_date as string) : new Date(0);

    try {
      const parsed = await parser.parseURL(feedUrl);
      const newEntries: { link: string; title: string; pubDate: Date }[] = [];

      for (const item of parsed.items ?? []) {
        if (!item.link) continue;
        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
        if (pubDate <= lastEntryDate) continue;
        newEntries.push({ link: item.link, title: item.title ?? '', pubDate });
      }

      if (newEntries.length > 0) {
        // Dedup against existing content_discovery
        const urls = newEntries.map(e => e.link);
        const { data: existing } = await sb.from('content_discovery').select('url').in('url', urls);
        const existingUrls = new Set((existing ?? []).map((r: { url: string }) => r.url));
        const fresh = newEntries.filter(e => !existingUrls.has(e.link));

        if (fresh.length > 0) {
          // Cap initial fetch at 30 entries to prevent capacity overload
          const RSS_INITIAL_LIMIT = 30;
          const isInitialFetch = !feed.last_entry_date;
          const toInsert = isInitialFetch ? fresh.slice(0, RSS_INITIAL_LIMIT) : fresh;
          if (isInitialFetch && fresh.length > RSS_INITIAL_LIMIT) {
            console.log(`[rss] initial fetch capped: ${toInsert.length}/${fresh.length} entries for "${feedTitle}"`);
          }
          // Estimated cost: ~$0.0002 per Haiku call (avg article ~250 input tokens)
          const estimatedCost = (toInsert.length * 0.0002).toFixed(4);
          console.log(`[rss] batch cost estimate: ${toInsert.length} Haiku calls ≈ $${estimatedCost} for "${feedTitle}"`);

          const discoveryRows = toInsert.map(e => ({
            url: e.link,
            title: e.title.slice(0, 500),
            source: `rss:${feedTitle.slice(0, 50)}`,
            status: 'pending',
            topic: feed.source_type ?? 'blog',
          }));
          await sb.from('content_discovery').insert(discoveryRows);
        }

        const maxDate = newEntries.reduce((max, e) => e.pubDate > max ? e.pubDate : max, lastEntryDate);
        const insertedCount = fresh.length > 0 ? Math.min(fresh.length, !feed.last_entry_date ? 30 : Infinity) : 0;
        await sb.from('rss_feeds').update({
          last_checked: new Date().toISOString(),
          last_entry_date: maxDate.toISOString(),
          total_entries_found: ((feed.total_entries_found as number) ?? 0) + insertedCount,
        }).eq('id', feed.id);

        newEntriesTotal += insertedCount;
        details.push({ feed: feedTitle, new_entries: insertedCount });
      } else {
        await sb.from('rss_feeds').update({ last_checked: new Date().toISOString() }).eq('id', feed.id);
        details.push({ feed: feedTitle, new_entries: 0 });
      }

      feedsChecked++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[rss] feed "${feedTitle}" failed:`, errMsg);
      // Still update last_checked to avoid hammering broken feeds
      await sb.from('rss_feeds').update({ last_checked: new Date().toISOString() }).eq('id', feed.id);
      details.push({ feed: feedTitle, new_entries: 0, error: errMsg.slice(0, 200) });
      feedsChecked++;
    }
  }

  console.log(`[rss] checked ${feedsChecked} feeds, ${newEntriesTotal} new entries`);
  res.json({ feeds_checked: feedsChecked, new_entries_total: newEntriesTotal, details });
});

/** GET /stats/feeds — RSS feed stats for Runner scheduling. */
app.get('/stats/feeds', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  const sb = createClient(pitstopUrl, pitstopKey);

  const { data, error } = await sb.rpc('get_feed_stats').maybeSingle() as { data: unknown; error: unknown };
  if (error || !data) {
    // Fallback: manual aggregate
    const { data: feeds, error: feedsErr } = await sb.from('rss_feeds').select('active,total_entries_found,total_processed,last_checked');
    if (feedsErr) { res.status(500).json({ error: String(feedsErr) }); return; }
    const rows = (feeds ?? []) as { active: boolean; total_entries_found: number; total_processed: number; last_checked: string | null }[];
    const total_feeds = rows.length;
    const active = rows.filter((r) => r.active).length;
    const total_entries = rows.reduce((s, r) => s + (r.total_entries_found || 0), 0);
    const processed = rows.reduce((s, r) => s + (r.total_processed || 0), 0);
    const last_check = rows.map((r) => r.last_checked).filter(Boolean).sort().pop() ?? null;
    res.json({ total_feeds, active, total_entries, processed, last_check });
    return;
  }
  res.json(data);
});

/** POST /process-rss — process pending RSS entries through fullPipeline. */
app.post('/process-rss', processLimiter, async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  const sb = createClient(pitstopUrl, pitstopKey);

  const { data: pending, error } = await sb
    .from('content_discovery')
    .select('id,url,title')
    .ilike('source', 'rss:%')
    .eq('processing_status', 'pending')
    .limit(5);

  if (error) { res.status(500).json({ error: String(error) }); return; }
  if (!pending || pending.length === 0) { res.json({ processed: 0, failed: 0, remaining: 0 }); return; }

  let processed = 0;
  let failed = 0;

  for (const entry of pending as { id: string; url: string; title: string | null }[]) {
    try {
      const source: Source = detectSource(entry.url);
      const result = await fullPipeline(entry.url, source);
      if ('duplicate' in result || 'youtube_unavailable' in result) {
        await sb.from('content_discovery').update({ processing_status: 'skipped' }).eq('id', entry.id);
      } else {
        await sb.from('content_discovery').update({ processing_status: 'processed' }).eq('id', entry.id);
        processed++;
      }
    } catch (e) {
      console.error(`[process-rss] failed ${entry.url}:`, e instanceof Error ? e.message : String(e));
      await sb.from('content_discovery').update({ processing_status: 'failed' }).eq('id', entry.id);
      failed++;
    }
  }

  const { count } = await sb
    .from('content_discovery')
    .select('id', { count: 'exact', head: true })
    .ilike('source', 'rss:%')
    .eq('processing_status', 'pending');

  res.json({ processed, failed, remaining: count ?? 0 });
});

// ── /process-ideas helpers ────────────────────────────────────────────────────

interface IdeaEvaluation {
  action: 'accepted' | 'rejected' | 'reworked' | 'already_done';
  reworked_content?: string;
  reason: string;
  urgency: number;
  impact: number;
  effort: '1h' | '4h' | '1d' | '3d' | '1w' | '2w+';
  category: 'maos_core' | 'intake' | 'monetization' | 'infrastructure' | 'knowledge' | 'research' | 'life_rpg';
  suggested_assignee: string;
  suggested_work_type: string;
  depends_on: string | null;
  priority_score: number;
}

function extractJSON(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) return t.slice(start, end + 1);
  return t;
}

async function evaluateIdea(idea: { id: string; content: string; source_type?: string; source_url?: string }): Promise<IdeaEvaluation> {
  const { callGeminiForText } = await import('./services/gemini');
  const prompt = `You are MAOS idea evaluator. Be CRITICAL and HONEST.

IDEA: "${idea.content}"
SOURCE: ${idea.source_type ?? 'unknown'} (${idea.source_url ?? 'unknown'})

MAOS CONTEXT: Personal multi-agent system. Stack: TypeScript, Node.js,
Supabase, Vercel/Railway, Telegram bot, Claude Code, Gemini.
Current: autorun works but unstable, YouTube pipeline working, RSS collecting,
no monetization yet, 341 ideas unreviewed.

EVALUATE:
1. Is this ACTIONABLE? (concrete steps, not vague advice)
2. Is this a DUPLICATE of obvious knowledge? ("use AI" = obvious)
3. Is it APPLICABLE to our stack? (Python-only = low value for us)
4. If this is just a DESCRIPTION of a product — can it be REWORDED into an action?
   Example: "Agent.ai is a platform" → REWORK to "Study Agent.ai marketplace model for selling MAOS agents"
5. Is this ALREADY DONE in MAOS? (WAA middleware, RSS pipeline, CEO evaluation = already exist)

Return ONLY JSON:
{
  "action": "accepted|rejected|reworked|already_done",
  "reworked_content": "Better version of the idea (only if action=reworked)",
  "reason": "One sentence why this action",
  "urgency": 0-10,
  "impact": 0-10,
  "effort": "1h|4h|1d|3d|1w|2w+",
  "category": "maos_core|intake|monetization|infrastructure|knowledge|research|life_rpg",
  "suggested_assignee": "nout|intaker|pekar|artur",
  "suggested_work_type": "blocker|critical_fix|enabling|product|nice_to_have|exploration",
  "depends_on": "what needs to exist first, or null",
  "priority_score": 0-100
}

REJECTION reasons: "too_vague", "duplicate_obvious", "wrong_stack", "already_done", "not_actionable"
REWORK: if idea has potential but poorly worded → action="reworked" + provide reworked_content`;

  const raw = await callGeminiForText(prompt);
  return JSON.parse(extractJSON(raw)) as IdeaEvaluation;
}

async function createTaskFromIdeaV2(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  title: string,
  evaluation: IdeaEvaluation,
  ideaId: string,
): Promise<void> {
  const systemMap: Record<string, string> = { intake: 'Intake', maos_core: 'Runner', infrastructure: 'Runner' };
  const { error } = await sb.from('tasks').insert({
    title: title.slice(0, 200),
    description: `Auto-created from idea. ${evaluation.reason}. Effort: ${evaluation.effort}. Depends: ${evaluation.depends_on ?? 'nothing'}.`,
    status: evaluation.urgency >= 8 ? 'todo' : 'backlog',
    work_type: evaluation.suggested_work_type,
    assignee: evaluation.suggested_assignee,
    source: 'idea_pipeline',
    system: systemMap[evaluation.category] ?? 'Cross-system',
  });
  if (error) { console.warn('[process-ideas] tasks insert failed:', error.message); return; }
  await sb.from('ideas').update({ converted_to_task: true }).eq('id', ideaId);
}

/** POST /process-ideas — AI evaluates unreviewed ideas via Gemini. Body: { limit? } */
app.post('/process-ideas', async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) { res.status(500).json({ error: 'Missing env vars' }); return; }
  if (!process.env.GEMINI_API_KEY) { res.status(500).json({ error: 'GEMINI_API_KEY not configured' }); return; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(pitstopUrl, pitstopKey);
  const limit = Math.min(Number(req.body?.limit) || 10, 20);

  const { data: ideas, error } = await sb
    .from('ideas')
    .select('id,content,source_type,source_url')
    .or('status.is.null,status.eq.new')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) { res.status(500).json({ error: String(error) }); return; }
  if (!ideas || ideas.length === 0) { res.json({ processed: 0, accepted: 0, reworked: 0, rejected: 0, already_done: 0, tasks_created: 0, results: [] }); return; }

  type Result = { id: string; action: string; reason: string; priority?: number };
  const results: Result[] = [];

  for (const idea of ideas as { id: string; content: string; source_type?: string; source_url?: string }[]) {
    try {
      const ev = await evaluateIdea(idea);
      const finalContent = ev.action === 'reworked' && ev.reworked_content ? ev.reworked_content : idea.content;
      const finalStatus = ev.action === 'reworked' ? 'accepted' : ev.action;

      await sb.from('ideas').update({
        status: finalStatus,
        content: finalContent,
        ai_analysis: ev,
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'gemini-auto',
        relevance: ev.impact >= 7 ? 'hot' : ev.impact >= 4 ? 'strategic' : 'low',
        rejection_reason: ev.action === 'rejected' ? ev.reason : null,
      }).eq('id', idea.id);

      if (['accepted', 'reworked'].includes(ev.action) && (ev.priority_score ?? 0) >= 20) {
        await createTaskFromIdeaV2(sb, finalContent, ev, idea.id).catch((e) =>
          console.warn('[process-ideas] createTask failed:', e instanceof Error ? e.message : String(e)),
        );
      }

      results.push({ id: idea.id, action: ev.action, reason: ev.reason, priority: ev.priority_score });
      console.log(`[process-ideas] ${idea.id}: ${ev.action} p=${ev.priority_score} — ${ev.reason}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[process-ideas] idea ${idea.id} failed:`, msg);
      results.push({ id: idea.id, action: 'error', reason: msg.slice(0, 100) });
    }
  }

  res.json({
    processed: results.length,
    accepted: results.filter((r) => r.action === 'accepted').length,
    reworked: results.filter((r) => r.action === 'reworked').length,
    rejected: results.filter((r) => r.action === 'rejected').length,
    already_done: results.filter((r) => r.action === 'already_done').length,
    tasks_created: results.filter((r) => (r.priority ?? 0) >= 20 && ['accepted', 'reworked'].includes(r.action)).length,
    results,
  });
});

/** POST /triage — per-idea Haiku triage with calibration few-shots. Body: { limit? }. */
app.post('/triage', async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!pitstopUrl || !pitstopKey || !anthropicKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const limit = Math.min(Number(req.body?.limit ?? 5), 20);

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  // API Cost Protection: max 1 retry. See incident 29.03.
  const anthropic = new AnthropicClient({ apiKey: anthropicKey, maxRetries: 1 });

  // Fetch few-shot calibration examples
  let fewShotBlock = '';
  try {
    const { data: calRows } = await sb
      .from('context_snapshots')
      .select('content')
      .eq('snapshot_type', 'calibration_data')
      .limit(5);
    const examples = (calRows ?? [])
      .map(r => {
        const c = r.content as Record<string, unknown>;
        if (c?.type !== 'idea_triage_calibration') return null;
        return `Идея: ${c.idea}\nРешение: ${c.decision}\nПричина: ${c.reason}`;
      })
      .filter(Boolean);
    if (examples.length > 0) {
      fewShotBlock = '\n\nПримеры калибровки:\n' + examples.join('\n---\n');
    }
  } catch (e) {
    console.warn('[triage] calibration fetch failed (non-fatal):', e instanceof Error ? e.message : String(e));
  }

  const SYSTEM = `Ты CEO MAOS — принимаешь решения об идеях для системы автономной разработки.
Стек: Node.js, TypeScript, Supabase, Claude/Haiku, React+Vite+Tailwind, Telegram Bot API, pgvector.
Принципы: не костыли, а разобраться и починить. Цель — полная автономность агентов.
Triage опирается на цели, потребности, задачи и контекст MAOS.

Для каждой идеи верни ОДИН из трёх вариантов:
- "approve": полезно, релевантно, оставить
- "reject": мусор / не наш стек / описание а не действие / generic / уже делаем / костыль
- "needs_clarification": потенциально ценно, но не хватает деталей

Верни ТОЛЬКО валидный JSON объект (без markdown):
{"decision":"approve"|"reject"|"needs_clarification","reason":"1 sentence"}${fewShotBlock}`;

  const { data: ideas, error: fetchErr } = await sb
    .from('ideas')
    .select('id, content, relevance, source_type, ai_category')
    .eq('status', 'new')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (fetchErr || !ideas || ideas.length === 0) {
    res.json({ processed: 0, approved: 0, rejected: 0, needs_clarification: 0, details: [] });
    return;
  }

  const details: { id: string; content: string; decision: string; reason: string }[] = [];
  let approved = 0;
  let rejected = 0;
  let needsClarification = 0;

  for (const idea of ideas) {
    const content = (idea.content as string ?? '').slice(0, 300);
    let decision = 'approve';
    let reason = '';

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Идея: ${content}\nТип: ${idea.ai_category ?? 'unknown'}\nРелевантность: ${idea.relevance ?? 'unknown'}`,
        }],
      });
      const raw = (msg.content[0] as { type: string; text: string }).text.trim();
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned) as { decision: string; reason: string };
      if (['approve', 'reject', 'needs_clarification'].includes(parsed.decision)) {
        decision = parsed.decision;
        reason = parsed.reason ?? '';
      }
    } catch (e) {
      console.error(`[triage] Haiku failed for idea ${idea.id}:`, e instanceof Error ? e.message : String(e));
      // Skip UPDATE, count as processed but not in details
      continue;
    }

    const ideaId = idea.id as string;
    const newStatus = decision === 'reject' ? 'rejected' : decision === 'needs_clarification' ? 'pending' : 'approved';
    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      reviewed_by: 'haiku-triage',
      reviewed_at: new Date().toISOString(),
    };
    if (decision === 'reject') updatePayload.rejection_reason = reason;

    const { error: updateErr, data: updateData } = await sb
      .from('ideas')
      .update(updatePayload)
      .eq('id', ideaId)
      .select('id, status, reviewed_by');

    if (updateErr) {
      console.error(`[triage] ❌ UPDATE failed for idea ${ideaId}: ${updateErr.message} (code: ${updateErr.code})`);
    } else {
      console.log(`[triage] ✅ UPDATE ok for idea ${ideaId}: status=${newStatus}, rows=${JSON.stringify(updateData)}`);
    }

    details.push({ id: ideaId, content: content.slice(0, 80), decision, reason });
    if (decision === 'approve') approved++;
    else if (decision === 'reject') rejected++;
    else needsClarification++;
  }

  console.log(`[triage] processed ${details.length}/${ideas.length}: ${approved} approved, ${rejected} rejected, ${needsClarification} needs_clarification`);

  res.json({
    processed: details.length,
    approved,
    rejected,
    needs_clarification: needsClarification,
    details,
  });
});

/** POST /auto-triage — batch triage all new ideas via Haiku LLM. Batches of 20. Can create tasks. */
app.post('/auto-triage', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!pitstopUrl || !pitstopKey || !anthropicKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  // API Cost Protection: max 1 retry. See incident 29.03.
  const anthropic = new AnthropicClient({ apiKey: anthropicKey, maxRetries: 1 });

  const BATCH = 20;
  const TRIAGE_SYSTEM = `Ты CEO MAOS. Наш стек: Node.js, TypeScript, Supabase, Claude/Haiku, React+Vite+Tailwind, Telegram Bot API, pgvector, Vercel.
Цель MAOS: мультиагентная автономная система разработки.

Для каждой идеи прими решение:
- "approve": полезно, релевантно нашему стеку, оставить для изучения
- "reject": мусор / не наш стек / описание а не действие / generic мотивация / уже делаем
- "task": actionable ПРЯМО СЕЙЧАС, конкретно и реализуемо за 1-3 дня

Верни ТОЛЬКО JSON массив (без markdown): [{"id":"...","decision":"approve"|"reject"|"task","reason":"1 sentence"}]
Количество элементов ДОЛЖНО совпадать с входным массивом.`;

  let totalApproved = 0;
  let totalRejected = 0;
  let totalTasks = 0;
  let totalErrors = 0;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: ideas, error: fetchErr } = await sb
      .from('ideas')
      .select('id, content, relevance, source_type')
      .or("status.eq.new,status.is.null")
      .order('created_at', { ascending: true })
      .range(offset, offset + BATCH - 1);

    if (fetchErr || !ideas || ideas.length === 0) { hasMore = false; break; }

    const input = ideas.map(i => ({
      id: i.id,
      content: (i.content as string).slice(0, 200),
      relevance: i.relevance ?? 'unknown',
    }));

    let decisions: { id: string; decision: string; reason: string }[] = [];
    try {
      console.log(`[auto-triage] Haiku batch call: max_tokens=1024, items=${input.length}`);
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: TRIAGE_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(input) }],
      });
      const raw = (msg.content[0] as { type: string; text: string }).text.trim();
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      decisions = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('[auto-triage] Haiku parse error:', e instanceof Error ? e.message : String(e));
      totalErrors += ideas.length;
      offset += BATCH;
      continue;
    }

    for (const d of decisions) {
      if (!d.id || !d.decision) continue;
      if (d.decision === 'reject') {
        await sb.from('ideas').update({
          status: 'rejected',
          rejection_reason: d.reason ?? null,
          reviewed_at: new Date().toISOString(),
          reviewed_by: 'haiku-auto-triage',
        }).eq('id', d.id);
        totalRejected++;
      } else if (d.decision === 'task') {
        const idea = ideas.find(i => i.id === d.id);
        const title = (idea?.content as string ?? '').slice(0, 120);
        await sb.from('tasks').insert({
          title,
          description: `Auto-triaged from idea.\n\nReason: ${d.reason ?? ''}`,
          status: 'backlog',
          priority: 'medium',
          source: 'idea_triage',
          created_by: 'haiku-auto-triage',
        });
        await sb.from('ideas').update({
          status: 'accepted',
          converted_to_task: true,
          reviewed_at: new Date().toISOString(),
          reviewed_by: 'haiku-auto-triage',
        }).eq('id', d.id);
        totalTasks++;
      } else {
        await sb.from('ideas').update({
          status: 'approved',
          reviewed_at: new Date().toISOString(),
          reviewed_by: 'haiku-auto-triage',
        }).eq('id', d.id);
        totalApproved++;
      }
    }

    console.log(`[auto-triage] batch offset=${offset}: ${decisions.length} decisions`);
    offset += BATCH;
    if (ideas.length < BATCH) hasMore = false;
  }

  const report = `Auto-triage: ${totalApproved} approved, ${totalRejected} rejected, ${totalTasks} → tasks${totalErrors > 0 ? `, ${totalErrors} errors` : ''}`;
  console.log('[auto-triage]', report);

  // Log to agent_action_log
  try {
    await sb.from('agent_action_log').insert({
      agent: 'intaker', action: 'auto_triage', status: 'done',
      details: { approved: totalApproved, rejected: totalRejected, tasks: totalTasks, errors: totalErrors },
      repo: 'maos-intake',
    });
  } catch (e) {
    logFailedAndContinue('agent_action_log_auto_triage', e as Error);
  }

  res.json({ success: true, approved: totalApproved, rejected: totalRejected, tasks: totalTasks, errors: totalErrors, report });
});

// T517: Bulk triage — keyword heuristics, no LLM cost
/** POST /triage-all — bulk keyword triage, zero LLM cost. Top 15% approved, bottom 35% rejected. */
app.post('/triage-all', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  // Fetch all untriaged ideas
  const { data: ideas, error: fetchErr } = await sb
    .from('ideas')
    .select('id, content, relevance, ai_category, source_type, source')
    .or("status.eq.new,status.is.null")
    .order('created_at', { ascending: true });

  if (fetchErr) {
    res.status(500).json({ error: fetchErr.message });
    return;
  }
  if (!ideas || ideas.length === 0) {
    res.json({ processed: 0, approved: 0, rejected: 0, review: 0 });
    return;
  }

  // Keyword-based scoring heuristics
  const HIGH_RELEVANCE = ['maos', 'autorun', 'agent', 'pipeline', 'intake', 'pitstop', 'runner',
    'supabase', 'claude', 'haiku', 'anthropic', 'vercel', 'telegram', 'pgvector',
    'typescript', 'node.js', 'express', 'embedding', 'vector', 'rag'];
  const MEDIUM_RELEVANCE = ['react', 'vite', 'tailwind', 'api', 'webhook', 'cron',
    'docker', 'ci/cd', 'github', 'deploy', 'monitoring', 'logging', 'auth'];
  const REJECT_SIGNALS = ['мотивация', 'motivation', 'mindset', 'productivity hack',
    'soft skill', 'leadership', 'career advice', 'generic'];
  const ACTION_VERBS = ['добавить', 'настроить', 'мигрировать', 'внедрить', 'implement',
    'add', 'configure', 'integrate', 'build', 'create', 'set up', 'automate'];

  type ScoredIdea = {
    id: string;
    content: string;
    relevance: number;
    effort: number;
    impact: number;
    priority: number;
  };

  const scored: ScoredIdea[] = ideas.map(idea => {
    const text = ((idea.content as string) ?? '').toLowerCase();
    const rel = idea.relevance as string | null;

    // Relevance (0-10)
    let relevance = 5; // baseline
    for (const kw of HIGH_RELEVANCE) {
      if (text.includes(kw)) { relevance += 1.5; break; }
    }
    for (const kw of MEDIUM_RELEVANCE) {
      if (text.includes(kw)) { relevance += 0.5; break; }
    }
    for (const kw of REJECT_SIGNALS) {
      if (text.includes(kw)) { relevance -= 3; break; }
    }
    if (rel === 'hot') relevance += 1;
    if (rel === 'strategic') relevance += 0.5;
    // Actionable verb bonus
    if (ACTION_VERBS.some(v => text.startsWith(v))) relevance += 1;
    relevance = Math.max(0, Math.min(10, relevance));

    // Effort (1-5): short = low effort, long = high effort
    const wordCount = text.split(/\s+/).length;
    const effort = wordCount < 15 ? 2 : wordCount < 40 ? 3 : 4;

    // Impact (1-5): based on relevance signal + category
    const cat = (idea.ai_category as string) ?? '';
    let impact = 3;
    if (cat === 'actionable_idea' || cat === 'tool_or_library') impact = 4;
    if (cat === 'architecture_pattern') impact = 4;
    if (rel === 'hot') impact = Math.min(5, impact + 1);
    if (REJECT_SIGNALS.some(kw => text.includes(kw))) impact = 1;

    const priority = effort > 0 ? (relevance * impact) / effort : 0;

    return { id: idea.id as string, content: text.slice(0, 100), relevance, effort, impact, priority };
  });

  // Sort by priority descending
  scored.sort((a, b) => b.priority - a.priority);

  // Top 20 → approved, bottom 50 → rejected, rest → review
  const topN = Math.min(20, Math.floor(scored.length * 0.15));
  const bottomN = Math.min(50, Math.floor(scored.length * 0.35));

  let approved = 0;
  let rejected = 0;
  let review = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < scored.length; i++) {
    const item = scored[i];
    let status: string;
    let priorityScore: number | null = null;

    if (i < topN) {
      status = 'approved';
      priorityScore = item.priority;
      approved++;
    } else if (i >= scored.length - bottomN) {
      status = 'rejected';
      rejected++;
    } else {
      status = 'review';
      priorityScore = item.priority;
      review++;
    }

    await sb.from('ideas').update({
      status,
      priority_score: priorityScore,
      reviewed_by: 'keyword-triage',
      reviewed_at: now,
    }).eq('id', item.id);
  }

  // Log to agent_action_log
  try {
    await sb.from('agent_action_log').insert({
      agent: 'intaker', action: 'triage_all', status: 'done',
      details: { total: scored.length, approved, rejected, review, top_5: scored.slice(0, 5).map(s => ({ id: s.id, priority: +s.priority.toFixed(2) })) },
      repo: 'maos-intake',
    });
  } catch (e) {
    logFailedAndContinue('agent_action_log_triage_all', e as Error);
  }

  console.log(`[triage-all] ${scored.length} ideas: ${approved} approved, ${rejected} rejected, ${review} review`);

  res.json({
    processed: scored.length,
    approved,
    rejected,
    review,
    top_5: scored.slice(0, 5).map(s => ({ id: s.id, content: s.content, priority: +s.priority.toFixed(2), relevance: s.relevance, impact: s.impact, effort: s.effort })),
    bottom_5: scored.slice(-5).map(s => ({ id: s.id, content: s.content, priority: +s.priority.toFixed(2) })),
  });
});

/** GET /heartbeat — cron heartbeat: quality check, entity backfill, daily auto-discover, Telegram report. */
app.get('/heartbeat', async (_req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const ts = new Date().toISOString();
  lastHeartbeatAt = ts;
  const result: Record<string, unknown> = { ts };

  if (pitstopUrl && pitstopKey) {
    try {
      const { createClient: mkSupabase } = await import('@supabase/supabase-js');
      const supabase = mkSupabase(pitstopUrl, pitstopKey);

      // Quality check: counts
      const [
        { count: knowledgeCount },
        { count: entityObjCount },
        { count: emptyEntityObj },
        { count: pendingCount },
      ] = await Promise.all([
        supabase.from('extracted_knowledge').select('*', { count: 'exact', head: true }),
        supabase.from('extracted_knowledge').select('*', { count: 'exact', head: true }).not('entity_objects', 'is', null).neq('entity_objects', '[]'),
        supabase.from('extracted_knowledge').select('*', { count: 'exact', head: true }).or('entity_objects.is.null,entity_objects.eq.[]'),
        supabase.from('ingested_content').select('*', { count: 'exact', head: true }).eq('processing_status', 'pending'),
      ]);

      result.knowledge_count = knowledgeCount ?? 0;
      result.entity_count = entityObjCount ?? 0;
      result.entity_objects_missing = emptyEntityObj ?? 0;
      result.pending_ingestion = pendingCount ?? 0;

      // Auto-backfill entity_objects if needed
      let backfill = null;
      if ((emptyEntityObj ?? 0) > 0) {
        console.log(`[heartbeat] ${emptyEntityObj} records need entity_objects backfill — running...`);
        backfill = await runEntityBackfill();
        result.backfill = backfill;
        console.log(`[heartbeat] backfill done: processed=${backfill.processed} remaining=${backfill.remaining}`);
        await supabase.from('agent_action_log').insert({
          agent: 'heartbeat',
          action: 'entity_backfill',
          details: { processed: backfill.processed, remaining: backfill.remaining },
          status: 'done',
        });
      }

      // Log health check
      await supabase.from('agent_action_log').insert({
        agent: 'heartbeat',
        action: 'health_check',
        details: {
          knowledge_count: knowledgeCount ?? 0,
          entity_count: entityObjCount ?? 0,
          pending: pendingCount ?? 0,
          timestamp: ts,
        },
        status: 'done',
      });

      // Auto-discover once per day (track via agent_action_log)
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const { count: todayDiscover } = await supabase
        .from('agent_action_log')
        .select('*', { count: 'exact', head: true })
        .eq('agent', 'heartbeat')
        .eq('action', 'auto_discover')
        .gte('created_at', today + 'T00:00:00Z');
      if ((todayDiscover ?? 0) === 0) {
        try {
          const { data: domains } = await supabase
            .from('knowledge_domains')
            .select('name')
            .eq('is_active', true)
            .limit(5);
          const topics = (domains ?? []).map((d: { name: string }) => d.name);
          if (topics.length > 0) {
            const discovered = await runAutoDiscover(topics, supabase);
            result.auto_discover = discovered;
            await supabase.from('agent_action_log').insert({
              agent: 'heartbeat',
              action: 'auto_discover',
              details: { topics, discovered },
              status: 'done',
            });
          }
        } catch (adErr) {
          console.error('[heartbeat] auto-discover failed:', adErr instanceof Error ? adErr.message : String(adErr));
        }
      }

      // Telegram status report
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId) {
        const pendingLine = (pendingCount ?? 0) > 0 ? `\n⚠️ Pending: ${pendingCount}` : '';
        const backfillLine = backfill ? `\n🔧 Backfill: +${backfill.processed} (осталось ${backfill.remaining})` : '';
        const discoverLine = result.auto_discover ? `\n🔍 Найдено: ${JSON.stringify(result.auto_discover)}` : '';
        const text = `🫀 Heartbeat: ${knowledgeCount ?? 0} знаний, ${entityObjCount ?? 0} с entities, ${emptyEntityObj ?? 0} без данных.${pendingLine}${backfillLine}${discoverLine}\nСистема работает.`;
        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
          });
        } catch (tgErr) {
          console.error('[heartbeat] Telegram failed:', tgErr instanceof Error ? tgErr.message : String(tgErr));
        }
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      console.error('[heartbeat] error:', result.error);
    }
  }

  res.json(result);
});

/** GET /api/lessons/extract — weekly cron (Sunday 00:00 UTC = 03:00 MSK).
 *  Reads gotcha/finding snapshots from past 7 days, extracts common patterns via Sonnet,
 *  saves lessons to context_snapshots, sends Telegram summary.
 */
app.get('/api/lessons/extract', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  console.log('[lessons] Cron triggered at:', ts);

  try {
    const { extractWeeklyLessons } = await import('./services/lessonsExtractor');
    const result = await extractWeeklyLessons();

    if (result.status === 'extracted' && (result.lessons_count ?? 0) > 0) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId) {
        const n = result.lessons_count ?? 0;
        const suffix = n === 1 ? '' : n < 5 ? 'а' : 'ов';
        const bulletLines = (result.lessons ?? [])
          .map((l) => `• ${l.rule_id}: ${l.prevention_rule}`)
          .join('\n');
        const text = `🧠 Извлечено ${n} урок${suffix} за неделю (из ${result.snapshots_analyzed} ошибок):\n${bulletLines}`;
        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
          });
        } catch (tgErr) {
          console.error('[lessons] Telegram failed:', tgErr instanceof Error ? tgErr.message : String(tgErr));
        }
      }
    }

    res.json({ ts, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[lessons] Unhandled error:', msg);
    res.status(500).json({ ts, status: 'error', error: msg });
  }
});

/** POST /api/entity-normalize/run — manual trigger for entity dedup backfill.
 *  Groups entity_nodes by lower(trim(name)), picks canonical per group (highest
 *  mention_count → oldest → lexicographic), rewires entity_edges and
 *  extracted_knowledge.entity_objects, deletes duplicates.
 *  Idempotent: re-running on a clean graph returns 0 deleted.
 */
app.post('/api/entity-normalize/run', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  console.log('[entity-normalize] Manual trigger at:', ts);
  try {
    const { runEntityNormalize } = await import('./entity-normalize/index');
    const result = await runEntityNormalize();
    res.json({ ts, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[entity-normalize] Unhandled error:', msg);
    res.status(500).json({ ts, status: 'error', error: msg });
  }
});

/** GET /api/auto-research/run — weekly cron (Monday 01:00 UTC).
 *  A/B tests extraction prompt variants on 50 fresh knowledge items, scores quality,
 *  writes winner to context_snapshots(prompt_optimization_result) and archives loser.
 */
app.get('/api/auto-research/run', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  console.log('[auto-research] Cron triggered at:', ts);
  try {
    const { runAutoResearch } = await import('./auto-research/index');
    const result = await runAutoResearch();
    res.json({ ts, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[auto-research] Unhandled error:', msg);
    res.status(500).json({ ts, status: 'error', error: msg });
  }
});

/** POST /generate-digest — weekly knowledge digest grouped by top tags. Zero LLM cost. */
app.post('/generate-digest', async (req: Request, res: Response) => {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) {
    res.status(500).json({ error: 'Missing env vars' });
    return;
  }

  const days = Math.min(Number(req.body?.days ?? 7), 30);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { createClient: mkSb } = await import('@supabase/supabase-js');
  const sb = mkSb(pitstopUrl, pitstopKey);

  const { data: rows, error: fetchErr } = await sb
    .from('extracted_knowledge')
    .select('content, entities, immediate_relevance, knowledge_type, source_url, created_at')
    .gte('created_at', since.toISOString())
    .order('immediate_relevance', { ascending: false })
    .limit(500);

  if (fetchErr) {
    res.status(500).json({ error: fetchErr.message });
    return;
  }
  if (!rows || rows.length === 0) {
    res.json({ digest: 'No knowledge items in the last ' + days + ' days.', total: 0 });
    return;
  }

  // Count tag frequency across all items
  const tagFreq = new Map<string, number>();
  for (const row of rows) {
    const tags = (row.entities as string[] | null) ?? [];
    for (const tag of tags) {
      const normalized = tag.trim().toLowerCase();
      if (normalized.length < 2) continue;
      tagFreq.set(normalized, (tagFreq.get(normalized) ?? 0) + 1);
    }
  }

  // Top tags sorted by frequency
  const sortedTags = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Group items by their highest-frequency tag
  type DigestItem = { content: string; score: number; source_url: string | null };
  const groups = new Map<string, DigestItem[]>();
  const assigned = new Set<number>();

  for (const [tag] of sortedTags) {
    const items: DigestItem[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (assigned.has(i)) continue;
      const row = rows[i];
      const tags = ((row.entities as string[] | null) ?? []).map((t: string) => t.trim().toLowerCase());
      if (tags.includes(tag)) {
        items.push({
          content: (row.content as string).slice(0, 120),
          score: row.immediate_relevance as number,
          source_url: row.source_url as string | null,
        });
        assigned.add(i);
      }
    }
    if (items.length > 0) {
      const displayTag = tag.charAt(0).toUpperCase() + tag.slice(1);
      groups.set(displayTag, items);
    }
  }

  // Collect unassigned items into "Other"
  const otherItems: DigestItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!assigned.has(i)) {
      otherItems.push({
        content: (rows[i].content as string).slice(0, 120),
        score: rows[i].immediate_relevance as number,
        source_url: rows[i].source_url as string | null,
      });
    }
  }
  if (otherItems.length > 0) {
    groups.set('Other', otherItems);
  }

  // Format date range
  const endDate = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateRange = `${months[since.getMonth()]} ${since.getDate()}\u2013${months[endDate.getMonth()]} ${endDate.getDate()}`;

  const emojis = ['\ud83d\udd27', '\ud83d\udca1', '\ud83e\udde0', '\ud83d\ude80', '\ud83d\udcca', '\ud83c\udfaf', '\u2699\ufe0f', '\ud83d\udce6', '\ud83d\udd0d', '\ud83c\udf10', '\ud83d\udcdd'];

  // Build digest text
  const lines: string[] = [`\ud83d\udcda MAOS Knowledge Digest (${dateRange})`, ''];
  let groupIdx = 0;
  for (const [tag, items] of groups) {
    const emoji = emojis[groupIdx % emojis.length];
    lines.push(`${emoji} ${tag} (${items.length} articles):`);
    const top = items.sort((a, b) => b.score - a.score).slice(0, 3);
    for (const item of top) {
      lines.push(`  - ${item.content}`);
    }
    lines.push('');
    groupIdx++;
  }

  const digest = lines.join('\n').trim();

  // Save to context_snapshots
  const snapshotContent = {
    type: 'weekly_digest',
    days,
    date_range: dateRange,
    total_items: rows.length,
    groups: [...groups.entries()].map(([tag, items]) => ({ tag, count: items.length, top: items.slice(0, 3).map(i => i.content) })),
    generated_at: new Date().toISOString(),
  };

  const { error: insertErr } = await sb
    .from('context_snapshots')
    .insert({ snapshot_type: 'weekly_digest', content: snapshotContent });

  if (insertErr) {
    console.warn('[generate-digest] context_snapshot insert failed:', insertErr.message);
  } else {
    console.log(`[generate-digest] digest saved: ${rows.length} items, ${groups.size} groups`);
  }

  res.json({ digest, total: rows.length, groups: groups.size });
});

// Local dev only — Vercel handles listening in serverless
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`maos-intake listening on port ${PORT}`);
  });
}

export default app;
