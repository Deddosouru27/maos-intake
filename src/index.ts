import 'dotenv/config';
import { createHash } from 'crypto';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { downloadAudio } from './handlers/youtube';
import { transcribeAudio } from './services/transcribe';
import { analyzeContent } from './services/analyze';
import { saveToMemory } from './services/memory';
import { saveIngestedContent, saveExtractedKnowledge, saveToPitstop } from './services/pitstop';
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

// Phase 2: analyze with retry — errors only on final attempt
async function analyzeWithRetry(
  rawText: string,
  url: string,
  retries = 3,
): Promise<BrainAnalysis> {
  for (let i = 0; i < retries; i++) {
    try {
      return await analyzeContent(rawText, url);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

// Phase 3: route + persist (fire-and-forget)
async function runPipeline(
  rawText: string,
  analysis: BrainAnalysis,
  sourceUrl: string,
  sourceType: string,
  contentHash: string,
  title?: string,
): Promise<string> {
  const routed = routeItems(analysis.knowledge_items);
  const hotItems = routed.filter((i) => i.routed_to === 'hot_backlog');
  const strategicItems = routed.filter((i) => i.routed_to === 'knowledge_base');
  const notification = buildNotification(routed);

  await Promise.allSettled([
    saveIngestedContent(rawText, sourceUrl, sourceType, title, contentHash),
    saveExtractedKnowledge(routed, sourceUrl, sourceType),
    saveToPitstop(analysis, hotItems, sourceType, sourceUrl),
    saveToMemory(analysis, strategicItems, sourceUrl, sourceUrl, sourceType),
  ]);

  return notification;
}

app.post('/process', processLimiter, async (req: Request, res: Response) => {
  const { url, source: providedSource } = req.body as ProcessBody;

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const source = detectSource(url, providedSource);

  try {
    // Instagram stub — no fetch needed
    if (source === 'instagram') {
      res.json({
        summary: 'Instagram не поддерживается',
        knowledge_items: [],
        overall_immediate: 0,
        overall_strategic: 0,
        priority_signal: false,
        priority_reason: '',
        category: 'other',
        language: 'other',
        notification: '📭 Instagram не поддерживается',
      });
      return;
    }

    // Phase 1: fetch
    const { rawText, title } = await fetchRawContent(url, source);
    const contentHash = computeHash(rawText);

    // Dedup check — skip analysis if content already processed
    const context = await getFullContext();
    if (context.recentHashes.includes(contentHash)) {
      console.log('[process] duplicate content, skipping analysis');
      res.json({ duplicate: true, notification: '♻️ Этот контент уже обрабатывался' });
      return;
    }

    // Phase 2: analyze
    const analysis = await analyzeWithRetry(rawText, url);
    console.log('Analysis result:', JSON.stringify(analysis, null, 2));

    // Respond immediately
    res.json(analysis);

    // Phase 3: persist in background
    runPipeline(rawText, analysis, url, source, contentHash, title)
      .then((notification) => console.log(`[process] ${notification}`))
      .catch(console.error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/process] error for ${url}:`, message);
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

      const analysis = await analyzeWithRetry(rawText, url);
      results.push(analysis);
      runPipeline(rawText, analysis, url, source, contentHash, title).catch(console.error);
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
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as {
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
