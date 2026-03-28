import Anthropic from '@anthropic-ai/sdk';
import { ContentAnalysis } from '../types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sendTelegramAlert(source: string, analysis: ContentAnalysis): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const text = `🚨 Приоритетный контент из ${source}:\n${analysis.summary}\nИдеи: ${analysis.ideas.join(', ')}`;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error('[analyze] Telegram alert failed:', err);
  }
}

export async function analyzeContent(text: string, source: string): Promise<ContentAnalysis> {
  const truncated = text.length > 8000 ? text.slice(0, 8000) + '...' : text;

  const prompt = `Проанализируй контент и верни ТОЛЬКО JSON без markdown и без пояснений:
{
  "summary": "краткое резюме 2-3 предложения",
  "ideas": ["идея 1", "идея 2"],
  "relevance_score": 0.8,
  "priority_signal": false,
  "tags": ["tag1", "tag2"]
}
Контент (источник: ${source}):
${truncated}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';

  let parsed: ContentAnalysis;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as ContentAnalysis;
  } catch {
    throw new Error(`Failed to parse Haiku response: ${raw}`);
  }

  if (parsed.priority_signal) {
    await sendTelegramAlert(source, parsed);
  }

  return parsed;
}
