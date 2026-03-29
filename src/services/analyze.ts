import Anthropic from '@anthropic-ai/sdk';
import { BrainAnalysis } from '../types';
import { getFullContext, buildSystemPrompt } from './projectContext';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sendTelegramAlert(source: string, analysis: BrainAnalysis): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const hotItems = analysis.knowledge_items
    .filter((i) => i.immediate_relevance >= 0.7 || i.has_ready_code)
    .map((i) => `• [${i.project ?? 'general'}] ${i.content}`)
    .join('\n');
  const reason = analysis.priority_reason ? `\nПричина: ${analysis.priority_reason}` : '';
  const text = `🚨 Приоритетный контент из ${source}:\n${analysis.summary}\n\nГорячие знания:\n${hotItems}${reason}`;
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

function parseHaikuJSON<T>(text: string): T {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in: ' + text.substring(0, 100));
  return JSON.parse(jsonMatch[0]) as T;
}

export async function analyzeContent(text: string, source: string): Promise<BrainAnalysis> {
  const truncated = text.length > 8000 ? text.slice(0, 8000) + '...' : text;

  const context = await getFullContext();
  const systemPrompt = buildSystemPrompt(context);

  const userPrompt = `Проанализируй и верни ТОЛЬКО JSON без markdown:

{
  "summary": "2-3 предложения на русском",
  "knowledge_items": [
    {
      "content": "Конкретное описание знания",
      "knowledge_type": "actionable_idea | tool_or_library | architecture_pattern | code_snippet | insight | technique | case_study | strategic_idea | lesson_learned",
      "project": "название проекта или null",
      "domains": ["название domain из списка"],
      "solves_need": "какую current_need решает или null",
      "immediate_relevance": 0.0,
      "strategic_relevance": 0.0,
      "novelty": 0.0,
      "effort": "trivial | low | medium | high | huge",
      "has_ready_code": false,
      "business_value": "Одно предложение — что это даст Артуру как директору, без технических терминов",
      "tags": ["теги"]
    }
  ],
  "overall_immediate": 0.0,
  "overall_strategic": 0.0,
  "priority_signal": false,
  "priority_reason": "",
  "category": "ai | dev | infrastructure | product | business | content | other",
  "language": "ru | en | other"
}

Контент: ${truncated}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';

  let parsed: BrainAnalysis;
  try {
    parsed = parseHaikuJSON<BrainAnalysis>(raw);
  } catch {
    throw new Error(`Failed to parse Haiku response: ${raw}`);
  }

  if (parsed.priority_signal) {
    await sendTelegramAlert(source, parsed);
  }

  return parsed;
}
