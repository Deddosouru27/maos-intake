import 'dotenv/config';
import express, { Request, Response } from 'express';
import { downloadAudio } from './handlers/youtube';
import { transcribeAudio } from './services/transcribe';
import { analyzeContent } from './services/analyze';
import { saveToMemory } from './services/memory';
import { saveToPitstop } from './services/pitstop';
import { fetchArticle } from './handlers/article';
import { ContentAnalysis } from './types';

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const PORT = parseInt(process.env.PORT ?? '3001', 10);

type Source = 'youtube' | 'instagram' | 'article' | 'url' | 'thread';

interface ProcessBody {
  url: string;
  source?: Source;
}

function detectSource(url: string, provided?: Source): Source {
  if (provided && provided !== 'url') return provided;
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('twitter.com') || url.includes('x.com') || url.includes('threads.net')) return 'thread';
  if (url.includes('instagram.com')) return 'instagram';
  return 'article';
}

app.get('/health', (_req: Request, res: Response) => {
  const key = (name: string) =>
    process.env[name] ? 'connected' : 'missing_key';

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      anthropic: key('ANTHROPIC_API_KEY'),
      groq: key('GROQ_API_KEY'),
      pitstop_supabase: key('PITSTOP_SUPABASE_ANON_KEY'),
      memory_supabase: key('MEMORY_SUPABASE_ANON_KEY'),
    },
  });
});

async function processUrl(url: string, source: Source): Promise<ContentAnalysis> {
  if (source === 'youtube') {
    const { audioPath } = await downloadAudio(url);
    const transcription = await transcribeAudio(audioPath);
    return analyzeContent(transcription.text, url);
  }

  if (source === 'thread') {
    const { fetchThread } = await import('./handlers/threads');
    const thread = await fetchThread(url);
    return analyzeContent(thread.text || url, url);
  }

  if (source === 'instagram') {
    return {
      summary: 'Instagram не поддерживается',
      ideas: [],
      relevance_score: 0,
      priority_signal: false,
      priority_reason: null,
      tags: [],
      category: 'other',
    };
  }

  const { text } = await fetchArticle(url);
  return analyzeContent(text, url);
}

app.post('/process', async (req: Request, res: Response) => {
  const { url, source: providedSource } = req.body as ProcessBody;

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const source = detectSource(url, providedSource);

  try {
    const analysis = await processUrl(url, source);
    console.log('Analysis result:', JSON.stringify(analysis, null, 2));

    res.json(analysis);
    Promise.allSettled([
      saveToMemory(analysis, url, url, source),
      saveToPitstop(analysis, source),
    ]).catch(console.error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/process] error for ${url}:`, message);
    res.status(500).json({ error: message });
  }
});

interface BatchBody {
  urls: string[];
}

app.post('/batch', async (req: Request, res: Response) => {
  const { urls } = req.body as BatchBody;

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls must be a non-empty array' });
    return;
  }

  if (urls.length > 10) {
    res.status(400).json({ error: 'Maximum 10 URLs per batch' });
    return;
  }

  const results: ContentAnalysis[] = [];
  const errors: { url: string; error: string }[] = [];

  for (const url of urls) {
    const source = detectSource(url);
    try {
      const analysis = await processUrl(url, source);
      results.push(analysis);
      Promise.allSettled([
        saveToMemory(analysis, url, url, source),
        saveToPitstop(analysis, source),
      ]).catch(console.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[/batch] error for ${url}:`, message);
      errors.push({ url, error: message });
    }
  }

  res.json({ results, errors });
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
      messages: [{
        role: 'user',
        content: `Суммаризируй текст в ${words} слов. Верни JSON: { "summary": string, "keyPoints": string[] } — только JSON без markdown\n\n${truncated}`,
      }],
    });

    const raw = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as { summary: string; keyPoints: string[] };

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
