import 'dotenv/config';
import { createHash } from 'crypto';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { extractFileText, detectFileSource, FileSourceType } from './handlers/file';
import { fetchYouTubeText, extractVideoId } from './handlers/youtube';
import { analyzeContent, analyzeWithChunking } from './services/analyze';
import { insertIngestedPending, updateIngestedDone, saveExtractedKnowledge, saveToPitstop } from './services/pitstop';
import { rerankItems } from './services/rerank';
import { fetchArticle, fetchWithJina } from './handlers/article';
import { fetchInstagramTranscript } from './apify';
import { getFullContext } from './services/projectContext';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem, RoutedTo } from './types';

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
  // Only trust provided if it's a known valid source — rejects 'link', 'url', garbage
  if (provided && VALID_SOURCES.has(provided)) return provided as Source;
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('twitter.com') || url.includes('x.com') || url.includes('threads.net'))
    return 'thread';
  if (url.includes('instagram.com')) return 'instagram';
  return 'article';
}

function computeHash(text: string): string {
  return createHash('sha256').update(text.slice(0, 1000)).digest('hex');
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

app.get('/status', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'maos-intake',
    timestamp: new Date().toISOString(),
    version: '1.0',
  });
});

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

  if (pitstopUrl && pitstopKey) {
    try {
      const { createClient: mk } = await import('@supabase/supabase-js');
      const sb = mk(pitstopUrl, pitstopKey);
      const queries = [
        sb.from('extracted_knowledge').select('*', { count: 'exact', head: true }),
        sb.from('extracted_knowledge').select('*', { count: 'exact', head: true }).not('entity_objects', 'is', null).neq('entity_objects', '[]'),
        sb.from('ingested_content').select('*', { count: 'exact', head: true }).eq('processing_status', 'pending'),
      ] as const;
      const base = await Promise.all(queries);
      knowledge_count = base[0].count ?? 0;
      entity_count = base[1].count ?? 0;
      pending_ingestion = base[2].count ?? 0;
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

  const response: Record<string, unknown> = {
    status: 'ok',
    knowledge_count,
    entity_count,
    pending_ingestion,
    last_heartbeat: lastHeartbeatAt,
    uptime: 'ok',
    services: {
      anthropic: key('ANTHROPIC_API_KEY'),
      groq: key('GROQ_API_KEY'),
      pitstop_supabase: key('PITSTOP_SUPABASE_ANON_KEY'),
      memory_supabase: key('MEMORY_SUPABASE_ANON_KEY'),
    },
  };

  if (isPreflight) {
    response.supabase = supabase_ok;
    response.telegram = telegram_ok;
    response.pending_tasks = pending_tasks;
  }

  res.json(response);
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

  // Jina Reader first — handles paywalls and JS-heavy sites better
  const jinaResult = await fetchWithJina(url);
  if (jinaResult && jinaResult.text.length > 100) {
    console.log('[INTAKE] Jina ok, length:', jinaResult.text.length);
    return { rawText: jinaResult.text, title: jinaResult.title };
  }

  // Fallback to readability
  console.log('[INTAKE] Using readability fallback');
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

  const routed = routeItems(rankedItems);
  const hotItems = routed.filter((i) => i.routed_to === 'hot_backlog');
  const strategicItems = routed.filter((i) => i.routed_to === 'knowledge_base');
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

  console.log('[PIPELINE] saving ideas...');
  try {
    await saveToPitstop(analysis, hotItems, sourceType, sourceUrl, knowledgeSaved);
    console.log('[PIPELINE] ideas ok');
  } catch (e) {
    console.error('[PIPELINE] ideas failed:', e instanceof Error ? e.message : String(e));
  }

  // Write-after-action: context_snapshot
  try {
    const pitstopUrl = process.env.PITSTOP_SUPABASE_URL ?? process.env.SUPABASE_PITSTOP_URL;
    const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY ?? process.env.SUPABASE_PITSTOP_ANON_KEY;
    if (!pitstopUrl || !pitstopKey) {
      console.warn('[PIPELINE] context_snapshot skipped: PITSTOP env vars not set');
    } else {
      const { createClient: mkSb } = await import('@supabase/supabase-js');
      const sb = mkSb(pitstopUrl, pitstopKey);
      const { data: proj } = await sb.from('projects').select('id').eq('name', 'MAOS').limit(1).single();
      const allEntities = analysis.knowledge_items.flatMap((i) => i.tags ?? []).filter(Boolean);
      const uniqueEntitiesCount = new Set(allEntities).size;
      await sb.from('context_snapshots').insert({
        project_id: (proj as { id: string } | null)?.id ?? null,
        snapshot_type: 'ai_summary',
        type: 'ai_summary',
        content: {
          type: 'intake_processing_log',
          source_url: sourceUrl,
          source_type: sourceType,
          knowledge_count: knowledgeSaved.length,
          hot_count: hotItems.length,
          entities_found: uniqueEntitiesCount,
          ideas_created: hotItems.length,
          duration_ms: Date.now() - pipelineStart,
          timestamp: new Date().toISOString(),
        },
      });
      console.log('[PIPELINE] context_snapshot written');
    }
  } catch (e) {
    console.warn('[PIPELINE] context_snapshot failed (non-fatal):', e instanceof Error ? e.message : String(e));
  }

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
async function fullPipeline(url: string, source: Source): Promise<{ notification: string; analysis: BrainAnalysis; diag: PipelineDiag } | { duplicate: true } | { youtube_unavailable: true }> {
  // 45s hard timeout — Vercel maxDuration is 60s, leaves buffer for network
  const timeoutId = setTimeout(() => {
    throw new Error('[INTAKE] Pipeline timeout (45s)');
  }, 45000);

  const startTime = Date.now();
  try {
    console.log('[PIPELINE] Starting for URL:', url, '| source:', source);

    // URL dedup: skip if same URL was ingested successfully in the last 10 minutes
    const { createClient: mkClient } = await import('@supabase/supabase-js');
    const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
    const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
    if (pitstopUrl && pitstopKey) {
      const sb = mkClient(pitstopUrl, pitstopKey);
      const { data: recent, error: dedupErr } = await sb
        .from('ingested_content')
        .select('id')
        .eq('source_url', url)
        .eq('processing_status', 'done')
        .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
        .limit(1);
      console.log('[PIPELINE] URL dedup check — recent done rows:', recent?.length ?? 0, dedupErr ? `err: ${dedupErr.message}` : 'ok');
      if (recent && recent.length > 0) {
        console.log('[PIPELINE] URL dedup HIT — skipping:', url);
        await writeIntakeLog({ url, stage: 'dedup_skip', duration_ms: Date.now() - startTime });
        return { duplicate: true };
      }
    } else {
      console.warn('[PIPELINE] PITSTOP env not set — skipping URL dedup');
    }
    console.log('[PIPELINE] URL dedup passed');

    console.log('[PIPELINE] 1. Fetching content...');
    const fetched = await fetchRawContent(url, source);

    if (fetched.youtube_unavailable) {
      return { youtube_unavailable: true };
    }

    const { rawText, title } = fetched;
    console.log(`[PIPELINE] 2. Fetched ${rawText.length} chars, title: ${title ?? 'none'}`);

    if (rawText.length < 30) {
      console.error('[PIPELINE] Content too short or empty — aborting, rawText:', JSON.stringify(rawText));
      return { notification: '⚠️ Контент не получен (пустой ответ от источника)', analysis: { summary: '', knowledge_items: [], overall_immediate: 0, overall_strategic: 0, priority_signal: false, priority_reason: '', category: 'empty', language: 'other' }, diag: { haikuItems: 0, itemsToSave: 0, savedItems: 0, dedupSkipped: 0, smartCrudUpdates: 0, haikuRaw: null } };
    }

    const contentHash = computeHash(rawText);
    console.log('[PIPELINE] 3. Content hash:', contentHash.slice(0, 8));

    let context;
    try {
      context = await getFullContext();
    } catch (err) {
      console.error('[PIPELINE] getFullContext FAILED:', err instanceof Error ? err.message : String(err));
      throw err;
    }
    console.log('[PIPELINE] 4. Context ok — projects:', context.projects.length, 'domains:', context.domains.length, 'recentHashes:', context.recentHashes.length);

    if (context.recentHashes.includes(contentHash)) {
      console.log('[PIPELINE] Content hash dedup HIT (cache):', contentHash.slice(0, 8));
      await writeIntakeLog({ url, stage: 'dedup_skip', duration_ms: Date.now() - startTime });
      return { duplicate: true };
    }
    // DB fallback — cache only holds last 100 done records
    if (pitstopUrl && pitstopKey) {
      const sb = mkClient(pitstopUrl, pitstopKey);
      const { data: hashRow } = await sb
        .from('ingested_content')
        .select('id')
        .eq('content_hash', contentHash)
        .eq('processing_status', 'done')
        .limit(1);
      if (hashRow && hashRow.length > 0) {
        console.log('[PIPELINE] Content hash dedup HIT (DB):', contentHash.slice(0, 8));
        await writeIntakeLog({ url, stage: 'dedup_skip', duration_ms: Date.now() - startTime });
        return { duplicate: true };
      }
    }

    // YouTube dedup by video ID (hash may differ due to caption format changes)
    if (source === 'youtube') {
      const videoId = extractVideoId(url);
      if (videoId && context.recentHashes.length > 0) {
        const { createClient } = await import('@supabase/supabase-js');
        if (pitstopUrl && pitstopKey) {
          const sb = createClient(pitstopUrl, pitstopKey);
          const { data } = await sb.from('ingested_content').select('id').ilike('source_url', `%${videoId}%`).limit(1);
          if (data && data.length > 0) {
            console.log('[PIPELINE] YouTube video ID dedup HIT:', videoId);
            return { duplicate: true };
          }
        }
      }
    }

    console.log('[PIPELINE] 4.5. Inserting ingested_content (pending)...');
    const ingestedId = await insertIngestedPending(rawText, url, source, title, contentHash);
    console.log('[PIPELINE] 4.5. ingestedId:', ingestedId);

    console.log('[PIPELINE] 5. Haiku analysis...');
    const analysis = await analyzeWithChunking(rawText, url);
    console.log(`[PIPELINE] 6. Analysis — items: ${analysis.knowledge_items.length}, immediate: ${analysis.overall_immediate.toFixed(2)}, strategic: ${analysis.overall_strategic.toFixed(2)}, category: ${analysis.category}`);

    if (analysis.category === 'parse_error') {
      console.error('[INTAKE] Parse error — saving parse_error status, skipping pipeline');
      if (ingestedId) {
        await updateIngestedDone(ingestedId, analysis, 'parse_error', 0, false, 'parse_error');
      }
      await writeIntakeLog({ url, stage: 'parse_error', haiku_items: 0, duration_ms: Date.now() - startTime, error: 'Haiku returned non-JSON' });
      return { notification: '⚠️ Haiku вернул не-JSON. Записано как parse_error.', analysis, diag: { haikuItems: 0, itemsToSave: 0, savedItems: 0, dedupSkipped: 0, smartCrudUpdates: 0, haikuRaw: analysis._haiku_raw ?? null } };
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

  const source = detectSource(url, providedSource);

  try {
    const result = await fullPipeline(url, source);
    if ('youtube_unavailable' in result) {
      res.json({
        success: true,
        status: 'youtube_unavailable',
        knowledge_count: 0,
        source_url: url,
        notification: '🎬 YouTube временно недоступен на этом сервере. Скопируй транскрипт через youtubetotranscript.com и отправь текстом',
      });
    } else if ('duplicate' in result) {
      res.json({ success: true, status: 'duplicate', knowledge_count: 0, source_url: url, notification: '♻️ Этот контент уже обрабатывался' });
    } else {
      res.json({ success: true, status: 'done', knowledge_count: result.analysis.knowledge_items.length, source_url: url, notification: result.notification, _diag: result.diag, ...result.analysis });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/process] pipeline failed for ${url}:`, message);
    res.status(500).json({ success: false, error: message });
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
  // DB fallback — cache only holds last 100 done records
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (pitstopUrl && pitstopKey) {
    const { data: hashRow } = await createClient(pitstopUrl, pitstopKey)
      .from('ingested_content')
      .select('id')
      .eq('content_hash', contentHash)
      .eq('processing_status', 'done')
      .limit(1);
    if (hashRow && hashRow.length > 0) {
      console.log('[INTAKE] Content hash dedup HIT (DB):', contentHash.slice(0, 8));
      return { duplicate: true };
    }
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
      const { rawText, title } = await fetchRawContent(url, source);
      const contentHash = computeHash(rawText);

      const context = await getFullContext();
      if (context.recentHashes.includes(contentHash)) {
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
          notification: '♻️ Этот контент уже обрабатывался',
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

interface SummarizeBody {
  text: string;
  maxLength?: number;
}

app.post('/summarize', async (req: Request, res: Response) => {
  const { text, maxLength } = req.body as SummarizeBody;

  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const truncated = text.length > 10000 ? text.slice(0, 10000) : text;
  const words = maxLength ?? 200;

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
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

async function runEntityBackfill(): Promise<{ processed: number; remaining: number }> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!pitstopUrl || !pitstopKey || !anthropicKey) return { processed: 0, remaining: 0 };

  const { createClient: mkSupabase } = await import('@supabase/supabase-js');
  const AnthropicSDK = (await import('@anthropic-ai/sdk')).default;
  const supabase = mkSupabase(pitstopUrl, pitstopKey);
  const anthropic = new AnthropicSDK({ apiKey: anthropicKey });

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

// Local dev only — Vercel handles listening in serverless
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`maos-intake listening on port ${PORT}`);
  });
}

export default app;
