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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/process', async (req: Request, res: Response) => {
  const { url, source: providedSource } = req.body as ProcessBody;

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const source = detectSource(url, providedSource);

  let analysis: ContentAnalysis;

  try {
    if (source === 'youtube') {
      const { audioPath } = await downloadAudio(url);
      const transcription = await transcribeAudio(audioPath);
      analysis = await analyzeContent(transcription.text, url);

    } else if (source === 'thread') {
      const { fetchThread } = await import('./handlers/threads');
      const thread = await fetchThread(url);
      analysis = await analyzeContent(thread.text || url, url);

    } else if (source === 'instagram') {
      analysis = {
        summary: 'Instagram не поддерживается',
        ideas: [],
        relevance_score: 0,
        priority_signal: false,
        tags: [],
        category: 'other',
      };

    } else {
      // article or url
      const { text } = await fetchArticle(url);
      analysis = await analyzeContent(text, url);
    }

    await saveToMemory(analysis, url, url, source);
    await saveToPitstop(analysis, source);

    res.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/process] error for ${url}:`, message);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`maos-intake listening on port ${PORT}`);
});
