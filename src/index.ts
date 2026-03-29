import 'dotenv/config';
import { createHash } from 'crypto';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { extractFileText, detectFileSource, FileSourceType } from './handlers/file';
import { downloadAudio } from './handlers/youtube';
import { transcribeAudio } from './services/transcribe';
import { analyzeContent } from './services/analyze';
import { saveToMemory } from './services/memory';
import { insertIngestedPending, updateIngestedDone, saveExtractedKnowledge, saveToPitstop } from './services/pitstop';
import { fetchArticle } from './handlers/article';
import { getFullContext } from './services/projectContext';
import { BrainAnalysis, KnowledgeItem, RoutedKnowledgeItem, RoutedTo } from './types';

const app = express();
app.use(express.json());
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

interface ProcessBody {
  url: string;
  source?: Source;
}

function detectSource(url: string, provided?: Source): Source {
  if (provided && provided !== 'url') return provided;
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

app.get('/health', (_req: Request, res: Response) => {
  const key = (name: string) => (process.env[name] ? 'connected' : 'missing_key');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    services: {
      anthropic: key('ANTHROPIC_API_KEY'),
      groq: key('GROQ_API_KEY'),
      pitstop_supabase: key('PITSTOP_SUPABASE_ANON_KEY'),
      memory_supabase: key('MEMORY_SUPABASE_ANON_KEY'),
    },
  });
});

// Phase 1: fetch raw content (no analysis — allows dedup check before API call)
async function fetchRawContent(
  url: string,
  source: Source,
): Promise<{ rawText: string; title?: string }> {
  if (source === 'youtube') {
    const { audioPath } = await downloadAudio(url);
    const transcription = await transcribeAudio(audioPath);
    return { rawText: transcription.text };
  }

  if (source === 'thread') {
    const { fetchThread } = await import('./handlers/threads');
    const thread = await fetchThread(url);
    return { rawText: thread.text || url };
  }

  if (source === 'instagram') {
    return { rawText: '' };
  }

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
): Promise<string> {
  const routed = routeItems(analysis.knowledge_items);
  const hotItems = routed.filter((i) => i.routed_to === 'hot_backlog');
  const strategicItems = routed.filter((i) => i.routed_to === 'knowledge_base');
  const discarded = routed.filter((i) => i.routed_to === 'discarded');
  const notification = buildNotification(routed);
  const routingResult = `hot:${hotItems.length},strategic:${strategicItems.length},discarded:${discarded.length}`;

  console.log(`[PIPELINE] routing: ${routingResult}, hash: ${contentHash.slice(0, 8)}`);

  // Update ingested_content with analysis results
  if (ingestedId) {
    await updateIngestedDone(ingestedId, analysis, routingResult);
  }

  // Save remaining in parallel
  console.log('[PIPELINE] saving extracted_knowledge / ideas / memory...');
  const results = await Promise.allSettled([
    saveExtractedKnowledge(routed, ingestedId, sourceUrl, sourceType),
    saveToPitstop(analysis, hotItems, sourceType, sourceUrl),
    saveToMemory(analysis, strategicItems, sourceUrl, sourceUrl, sourceType),
  ]);
  results.forEach((r, i) => {
    const label = ['extracted_knowledge', 'ideas', 'memory'][i];
    if (r.status === 'rejected') console.error(`[PIPELINE] ${label} failed:`, r.reason);
    else console.log(`[PIPELINE] ${label} ok`);
  });

  return notification;
}

async function fullPipeline(url: string, source: Source): Promise<{ notification: string; analysis: BrainAnalysis } | { duplicate: true }> {
  // 45s hard timeout — Vercel maxDuration is 60s, leaves buffer for network
  const timeoutId = setTimeout(() => {
    throw new Error('[INTAKE] Pipeline timeout (45s)');
  }, 45000);

  try {
    console.log('[INTAKE] 1. Fetching URL...');
    const { rawText, title } = await fetchRawContent(url, source);
    console.log(`[INTAKE] 2. Fetched ${rawText.length} chars, title: ${title ?? 'none'}`);

    const contentHash = computeHash(rawText);
    console.log('[INTAKE] 3. Dedup check, hash:', contentHash.slice(0, 8));

    const context = await getFullContext();
    if (context.recentHashes.includes(contentHash)) {
      console.log('[INTAKE] Duplicate content, skipping');
      return { duplicate: true };
    }
    console.log('[INTAKE] 4. Context ok — projects:', context.projects.length, 'domains:', context.domains.length);

    // Insert pending BEFORE Haiku — dedup works even if analysis fails
    console.log('[INTAKE] 4.5. Saving ingested_content (pending)...');
    const ingestedId = await insertIngestedPending(rawText, url, source, title, contentHash);
    console.log('[INTAKE] ingested_content id:', ingestedId);

    console.log('[INTAKE] 5. Haiku analysis (single call, no retry)...');
    const analysis = await analyzeContent(rawText, url);
    console.log(`[INTAKE] 6. Analysis ok — items: ${analysis.knowledge_items.length}, immediate: ${analysis.overall_immediate}, strategic: ${analysis.overall_strategic}`);

    const notification = await runPipeline(ingestedId, analysis, url, source, contentHash);
    console.log(`[INTAKE] 7. Done — ${notification}`);
    return { notification, analysis };
  } finally {
    clearTimeout(timeoutId);
  }
}

app.post('/process', processLimiter, async (req: Request, res: Response) => {
  const { url, source: providedSource } = req.body as ProcessBody;

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const source = detectSource(url, providedSource);

  if (source === 'instagram') {
    res.json({ status: 'unsupported', notification: '📭 Instagram не поддерживается' });
    return;
  }

  try {
    const result = await fullPipeline(url, source);
    if ('duplicate' in result) {
      res.json({ status: 'duplicate', notification: '♻️ Этот контент уже обрабатывался' });
    } else {
      res.json({ status: 'done', notification: result.notification, ...result.analysis });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/process] pipeline failed for ${url}:`, message);
    res.status(500).json({ error: message });
  }
});

// Shared pipeline for pre-fetched text (files, etc.)
async function rawTextPipeline(
  rawText: string,
  sourceType: string,
  label: string,
  title?: string,
): Promise<void> {
  const contentHash = computeHash(rawText);

  const context = await getFullContext();
  if (context.recentHashes.includes(contentHash)) {
    console.log('[INTAKE] Duplicate content, skipping');
    return;
  }

  const ingestedId = await insertIngestedPending(rawText, label, sourceType, title, contentHash);

  console.log('[INTAKE] 5. Haiku analysis (single call)...');
  const analysis = await analyzeContent(rawText, label);

  const notification = await runPipeline(ingestedId, analysis, label, sourceType, contentHash);
  console.log(`[INTAKE] Done — ${notification}`);
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
  urls: string[];
}

app.post('/batch', processLimiter, async (req: Request, res: Response) => {
  const { urls } = req.body as BatchBody;

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls must be a non-empty array' });
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
      if (source === 'instagram') {
        results.push({
          summary: 'Instagram не поддерживается',
          knowledge_items: [],
          overall_immediate: 0,
          overall_strategic: 0,
          priority_signal: false,
          priority_reason: '',
          category: 'other',
          language: 'other',
        });
        continue;
      }

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

// Local dev only — Vercel handles listening in serverless
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`maos-intake listening on port ${PORT}`);
  });
}

export default app;
