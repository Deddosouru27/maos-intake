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
  if (!jsonMatch) {
    throw new Error('No JSON found in: ' + text.substring(0, 200));
  }
  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    // JSON truncated — try to repair closing brackets
    let fixed = jsonMatch[0];
    fixed = fixed.replace(/,\s*$/, '');
    const opens = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
    const braces = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
    if (opens > 0) fixed += ']'.repeat(opens);
    if (braces > 0) fixed += '}'.repeat(braces);
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fixed) as T;
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      console.error('[INTAKE] JSON parse final fail:', msg, 'raw last 100:', text.slice(-100));
      throw new Error('JSON parse failed after repair: ' + msg);
    }
  }
}

const MAX_CHARS_FOR_HAIKU = 12000;

export async function analyzeContent(text: string, source: string): Promise<BrainAnalysis> {
  const trimmedText = text.length > MAX_CHARS_FOR_HAIKU
    ? text.substring(0, MAX_CHARS_FOR_HAIKU) + '\n[...текст обрезан...]'
    : text;

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

Контент: ${trimmedText}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  const cost = (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;
  console.log(`[INTAKE] Haiku cost: $${cost.toFixed(4)} (in:${inputTokens} out:${outputTokens})`);

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';

  let parsed: BrainAnalysis;
  try {
    parsed = parseHaikuJSON<BrainAnalysis>(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse Haiku response: ${msg}`);
  }

  if (parsed.priority_signal) {
    await sendTelegramAlert(source, parsed);
  }

  return parsed;
}
