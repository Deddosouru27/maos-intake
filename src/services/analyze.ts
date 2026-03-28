import { ContentAnalysis } from '../types';

// Stub — real Claude Haiku integration wired via src/analyzer.ts in next iteration
export async function analyzeContent(text: string, source: string): Promise<ContentAnalysis> {
  console.log(`[analyze] stub called for source=${source}, text length=${text.length}`);

  return {
    summary: `[mock] Content from ${source} (${text.length} chars)`,
    ideas: ['idea placeholder 1', 'idea placeholder 2'],
    relevance_score: 0.5,
    priority_signal: 'medium',
    tags: ['untagged'],
  };
}
