import Anthropic from '@anthropic-ai/sdk';
import { BrainAnalysis, KnowledgeItem, KnowledgeType, EffortLevel } from '../types';
import { getFullContext, buildContextString } from './projectContext';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a knowledge extraction engine. Extract insights from content.
ALWAYS respond in Russian. All content, business_value, and summary must be in Russian language.
RULES:
Extract 8-12 insights. More is better than fewer.
IGNORE: ads, sponsors, promotions, self-promotion, affiliate links, off-topic tangents.
IGNORE: product placements, affiliate promotions, unrelated tangents. Only extract insights about the main topic.
Each insight must be actionable or strategically valuable.
Be CONCISE. Maximum 2 sentences per insight.
business_value: 1 sentence only.
Output ONLY valid JSON. No markdown, no commentary.
SCORING CALIBRATION:
- immediate_relevance (r) 0.7+ means: THIS DIRECTLY SOLVES a current task or current_need listed in context. Not just 'related to AI'. Must match a SPECIFIC project need.
- immediate_relevance 0.3-0.7 means: useful for our direction but no specific task right now
- immediate_relevance <0.3 means: interesting but not related to current projects
- strategic_relevance (s) 0.7+ means: directly in our knowledge_domains with high priority
- strategic_relevance 0.3-0.7 means: tangentially related to our domains
- strategic_relevance <0.3 means: outside our focus areas
- Be STRICT. Most content should score 0.4-0.6. Only truly actionable items get 0.7+.
- Generic AI advice without specific tool/method = max 0.5 immediate.`;

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

function repairControlChars(s: string): string {
  return s.replace(/[\x00-\x1F\x7F]/g, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return '';
  });
}

function parseHaikuJSON<T>(text: string): T {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in: ' + text.substring(0, 200));
  }
  const candidate = repairControlChars(jsonMatch[0]);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // JSON truncated — try to repair closing brackets
    let fixed = candidate;
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
const MAX_CHUNK_WORDS = 4000;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS = 20;

export async function analyzeWithChunking(text: string, source: string): Promise<BrainAnalysis> {
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length <= MAX_CHUNK_WORDS) {
    return analyzeContent(text, source);
  }

  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS - CHUNK_OVERLAP) {
    chunks.push(words.slice(i, i + MAX_CHUNK_WORDS).join(' '));
    if (chunks.length >= MAX_CHUNKS) break;
  }
  console.log(`[CHUNKING] ${words.length} words → ${chunks.length} chunks`);

  const allItems: KnowledgeItem[] = [];
  let firstSummary = '';
  let maxImmediate = 0;
  let maxStrategic = 0;
  let prioritySignal = false;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[CHUNKING] chunk ${i + 1}/${chunks.length}`);
    try {
      const result = await analyzeContent(chunks[i], source);
      allItems.push(...result.knowledge_items);
      if (i === 0) firstSummary = result.summary;
      maxImmediate = Math.max(maxImmediate, result.overall_immediate);
      maxStrategic = Math.max(maxStrategic, result.overall_strategic);
      if (result.priority_signal) prioritySignal = true;
    } catch (e) {
      console.error(`[CHUNKING] chunk ${i + 1} failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  return {
    summary: firstSummary || `Обработано ${chunks.length} частей, извлечено ${allItems.length} знаний`,
    knowledge_items: allItems,
    overall_immediate: maxImmediate,
    overall_strategic: maxStrategic,
    priority_signal: prioritySignal,
    priority_reason: '',
    category: 'other',
    language: 'other',
  };
}

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
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  const cost = (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;
  console.log(`[INTAKE] Haiku cost: $${cost.toFixed(4)} (in:${inputTokens} out:${outputTokens})`);

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  console.log('[HAIKU] Raw response first 200 chars:', raw.slice(0, 200));

  let compact: CompactResponse;
  try {
    compact = parseHaikuJSON<CompactResponse>(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[HAIKU] JSON parse failed:', msg);
    console.error('[HAIKU] Attempted to parse (first 300):', raw.slice(0, 300));
    return {
      summary: 'JSON parse failed',
      knowledge_items: [],
      overall_immediate: 0,
      overall_strategic: 0,
      priority_signal: false,
      priority_reason: 'parse_error',
      category: 'parse_error',
      language: 'other',
      _haiku_raw: raw.slice(0, 300),
    };
  }

  console.log('[ANALYZE] Parsed result keys:', Object.keys(compact));
  console.log('[ANALYZE] Items count:', compact?.items?.length ?? 0);

  const analysis = expandCompactResponse(compact);

  if (analysis.priority_signal) {
    await sendTelegramAlert(source, analysis);
  }

  return analysis;
}
