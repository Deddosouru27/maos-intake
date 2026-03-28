import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import { handleArticle } from './handlers/article';
import { handleYoutube } from './handlers/youtube';
import { handleText } from './handlers/text';
import { analyze } from './analyzer';
import { saveIdea } from './supabase';
import { IntakeResult } from './types';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

const POLL_INTERVAL_MS = 10_000;

async function processJob(job: { id: string; url: string; source_type?: string }): Promise<void> {
  const input = job.url;
  let content: string;
  let sourceType: string;
  let sourceUrl: string | undefined;

  const isUrl = input.startsWith('http://') || input.startsWith('https://');

  if (isUrl) {
    sourceUrl = input;
    const isYoutube = input.includes('youtube.com') || input.includes('youtu.be');
    if (isYoutube) {
      content = await handleYoutube(input);
      sourceType = 'youtube';
    } else {
      content = await handleArticle(input);
      sourceType = 'article';
    }
  } else {
    content = await handleText(input);
    sourceType = job.source_type ?? 'text';
  }

  const analysis = await analyze(content);

  const result: IntakeResult = {
    content,
    summary: analysis.summary,
    extracted_ideas: analysis.extracted_ideas,
    relevance: analysis.relevance,
    source_type: sourceType,
    source_url: sourceUrl,
  };

  await saveIdea(result, config.projectId);
}

async function poll(): Promise<void> {
  console.log('Polling for pending ideas...');

  const { data: jobs, error } = await supabase
    .from('ideas')
    .select('id, source_url, source_type')
    .eq('status', 'pending')
    .limit(5);

  if (error) {
    console.error('Poll error:', error.message);
    return;
  }

  if (!jobs || jobs.length === 0) {
    return;
  }

  console.log(`Found ${jobs.length} pending jobs.`);

  for (const job of jobs) {
    const url = job.source_url as string;
    if (!url) continue;

    console.log(`Processing job ${job.id as string}: ${url}`);

    // Mark as processing
    await supabase.from('ideas').update({ status: 'processing' }).eq('id', job.id);

    try {
      await processJob({ id: job.id as string, url, source_type: job.source_type as string });
      await supabase.from('ideas').update({ status: 'done' }).eq('id', job.id);
      console.log(`Job ${job.id as string} done.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase
        .from('ideas')
        .update({ status: 'failed', ai_analysis: { error: message } })
        .eq('id', job.id);
      console.error(`Job ${job.id as string} failed: ${message}`);
    }
  }
}

async function main(): Promise<void> {
  console.log('maos-intake polling service started.');
  console.log(`Supabase: ${config.supabaseUrl}`);
  console.log(`Project: ${config.projectId}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  await poll();
  setInterval(() => {
    poll().catch((err) => console.error('Unexpected poll error:', err));
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
