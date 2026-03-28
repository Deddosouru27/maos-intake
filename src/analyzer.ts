import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

interface AnalysisResult {
  summary: string;
  extracted_ideas: string[];
  relevance: 'hot' | 'interesting' | 'noise';
}

const client = new Anthropic({ apiKey: config.anthropicKey });

export async function analyze(content: string): Promise<AnalysisResult> {
  const truncated = content.length > 4000 ? content.slice(0, 4000) + '...' : content;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system:
      'Ты анализируешь контент. Верни только валидный JSON без markdown-блоков: { "summary": "краткое описание", "extracted_ideas": ["идея1", "идея2"], "relevance": "hot"|"interesting"|"noise" }',
    messages: [
      {
        role: 'user',
        content: truncated,
      },
    ],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '';

  try {
    const parsed = JSON.parse(text) as AnalysisResult;
    return parsed;
  } catch {
    // Try to extract JSON from the response if it's wrapped in markdown
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as AnalysisResult;
    }
    throw new Error(`Failed to parse analyzer response: ${text}`);
  }
}
