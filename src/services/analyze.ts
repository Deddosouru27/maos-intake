import Anthropic from '@anthropic-ai/sdk';
import { BrainAnalysis, KnowledgeItem, KnowledgeType, EffortLevel } from '../types';
import { getFullContext, buildContextString } from './projectContext';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a knowledge extraction engine. Extract insights from content.
RULES:
Extract 8-12 insights. More is better than fewer.
IGNORE: ads, sponsors, promotions, self-promotion, affiliate links, off-topic tangents.
Each insight must be actionable or strategically valuable.
Be CONCISE. Maximum 2 sentences per insight.
business_value: 1 sentence only.
Output ONLY valid JSON. No markdown, no commentary.`;

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

interface CompactItem {
  t: string;
  c: string;
  b: string;
  s: number;
  r: number;
}

interface CompactResponse {
  items: CompactItem[];
  summary: string;
}

function expandCompactResponse(parsed: CompactResponse): BrainAnalysis {
  const knowledge_items: KnowledgeItem[] = (parsed.items ?? []).map((item) => {
    const kt: KnowledgeType =
      item.t === 'pattern' ? 'architecture_pattern'
      : item.t === 'tool' ? 'tool_or_library'
      : item.t === 'lesson' ? 'lesson_learned'
      : item.t === 'idea' ? 'actionable_idea'
      : item.t === 'technique' ? 'technique'
      : 'insight';
    return {
      knowledge_type: kt,
      content: item.c ?? '',
      business_value: item.b ?? null,
      strategic_relevance: item.s ?? 0,
      immediate_relevance: item.r ?? 0,
      project: null,
      domains: [],
      solves_need: null,
      novelty: 0.5,
      effort: 'medium' as EffortLevel,
      has_ready_code: false,
      tags: [],
    };
  });

  const overall_immediate = knowledge_items.length > 0
    ? knowledge_items.reduce((sum, i) => sum + i.immediate_relevance, 0) / knowledge_items.length
    : 0;
  const overall_strategic = knowledge_items.length > 0
    ? knowledge_items.reduce((sum, i) => sum + i.strategic_relevance, 0) / knowledge_items.length
    : 0;
  const priority_signal = knowledge_items.some((i) => i.immediate_relevance >= 0.8);

  return {
    summary: parsed.summary ?? '',
    knowledge_items,
    overall_immediate,
    overall_strategic,
    priority_signal,
    priority_reason: '',
    category: 'other',
    language: 'other',
  };
}

const MAX_CHARS_FOR_HAIKU = 12000;

export async function analyzeContent(text: string, source: string): Promise<BrainAnalysis> {
  const trimmedText = text.length > MAX_CHARS_FOR_HAIKU
    ? text.substring(0, MAX_CHARS_FOR_HAIKU) + '\n[...текст обрезан...]'
    : text;

  const context = await getFullContext();
  const trimmedContext = buildContextString(context);

  const userPrompt = `Content to analyze:
"""
${trimmedText}
"""
Context about the user's projects and priorities:
"""
${trimmedContext}
"""
Extract 8-12 insights as JSON. Remember: CONCISE, no ads, only actionable insights.

{
  "items": [
    {
      "t": "insight type: insight|pattern|tool|lesson|idea|technique",
      "c": "Insight content. Max 2 sentences.",
      "b": "Business value. 1 sentence.",
      "s": 0.7,
      "r": 0.5
    }
  ],
  "summary": "3 sentence summary of entire content."
}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  const cost = (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;
  console.log(`[INTAKE] Haiku cost: $${cost.toFixed(4)} (in:${inputTokens} out:${outputTokens})`);

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';

  let compact: CompactResponse;
  try {
    compact = parseHaikuJSON<CompactResponse>(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse Haiku response: ${msg}`);
  }

  const analysis = expandCompactResponse(compact);

  if (analysis.priority_signal) {
    await sendTelegramAlert(source, analysis);
  }

  return analysis;
}
