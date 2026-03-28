import 'dotenv/config';
import { handleArticle } from './handlers/article';
import { handleYoutube } from './handlers/youtube';
import { handleText } from './handlers/text';
import { analyze } from './analyzer';
import { saveIdea } from './supabase';
import { config } from './config';
import { IntakeResult } from './types';

async function processInput(input: string): Promise<void> {
  let content: string;
  let sourceType: string;
  let sourceUrl: string | undefined;

  const isUrl = input.startsWith('http://') || input.startsWith('https://');

  if (isUrl) {
    sourceUrl = input;
    const isYoutube = input.includes('youtube.com') || input.includes('youtu.be');
    if (isYoutube) {
      console.log('Processing YouTube URL...');
      content = await handleYoutube(input);
      sourceType = 'youtube';
    } else {
      console.log('Processing article URL...');
      content = await handleArticle(input);
      sourceType = 'article';
    }
  } else {
    console.log('Processing plain text...');
    content = await handleText(input);
    sourceType = 'text';
  }

  console.log(`Content extracted (${content.length} chars). Analyzing...`);
  const analysis = await analyze(content);

  const result: IntakeResult = {
    content,
    summary: analysis.summary,
    extracted_ideas: analysis.extracted_ideas,
    relevance: analysis.relevance,
    source_type: sourceType,
    source_url: sourceUrl,
  };

  console.log('\n--- Analysis Result ---');
  console.log('Summary:', result.summary);
  console.log('Relevance:', result.relevance);
  console.log('Extracted ideas:', result.extracted_ideas);

  await saveIdea(result, config.projectId);
  console.log('\nSaved to Supabase.');
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: tsx src/process.ts "<url or text>"');
  process.exit(1);
}

processInput(input).catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
