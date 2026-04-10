import Anthropic from '@anthropic-ai/sdk';
import { BrainAnalysis, KnowledgeItem, KnowledgeType, EffortLevel, EntityObject, EntityRelationship, EntityRelationshipType } from '../types';
import { getFullContext, buildContextString } from './projectContext';

// API Cost Protection: max 1 retry. See incident 29.03.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });

// Circuit breaker state — reset on process restart
let consecutiveEmptyResponses = 0;
const CIRCUIT_BREAKER_THRESHOLD = 3;

async function logQuarantine(source: string, reason: string): Promise<void> {
  const ts = new Date().toISOString();
  console.error(`[QUARANTINE] ${ts} source=${source} reason=${reason} consecutive=${consecutiveEmptyResponses}`);
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) return;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url, key);
    await sb.from('agent_events').insert({
      event_type: 'llm_quarantine',
      details: { source, reason, consecutive: consecutiveEmptyResponses, ts },
    });
  } catch { /* non-blocking */ }
}

const SYSTEM_PROMPT = `CONTEXT: You extract knowledge for MAOS — a personal AI business brain and multi-agent autonomous development system.
Owner interests: AI agents, automation, SaaS, TypeScript/Node.js, Supabase, Telegram bots, knowledge pipelines, developer tooling.
QUALITY RULES:
- Extract ACTIONABLE insights, not summaries or descriptions. Each insight must be a concrete technique or tool recommendation.
- Tags must be specific: "Supabase Edge Functions" not "technology", "Vite 6 HMR" not "build tool".
- Entities: only named tools, people, companies, projects — never generic concepts like "framework", "monitoring", "automation".
- If content is not relevant to AI/tech/business/developer tooling → set all relevance scores < 0.3.
- key_points (c field) must be concrete techniques, not "article discusses X" or "author explains Y".
BAD insights: "Статья рассматривает подходы к автоматизации" | "Обсуждаются вопросы масштабирования" | "Автор рассказывает о преимуществах микросервисов"
GOOD insights: "n8n webhook + Telegram bot automates lead qualification in 2 hours" | "pgvector HNSW index 10x faster than IVFFlat for <1M rows" | "Claude tool_use with structured output eliminates JSON parse errors"

ALWAYS respond in Russian. All content, business_value, and summary must be in Russian language.
RULES:
Extract the most important and actionable insights (limit set per request).
IGNORE: ads, sponsors, promotions, self-promotion, affiliate links, off-topic tangents.
IGNORE: product placements, affiliate promotions, unrelated tangents. Only extract insights about the main topic.
Each insight must be actionable or strategically valuable.
Be CONCISE. Maximum 2 sentences per insight.
business_value: 1 sentence only.
Output ONLY valid JSON. No markdown, no commentary.
SCORING (immediate_relevance r) — СТРОГО:
0.8+ = actionable THIS WEEK с нашим текущим кодом. Конкретный инсайт, реализуемый за 1-2 дня.
0.5-0.7 = полезно стратегически, НО ТОЛЬКО если контент прямо релевантен НАШЕМУ стеку: Node.js, TypeScript, Supabase, Claude/Haiku, Vercel, React+Vite+Tailwind, Telegram Bot API, pgvector. Если про другой стек (Python, Go, Rust, Next.js SSR, Django) → максимум 0.4.
0.3-0.5 = DEFAULT для большинства контента. Если сомневаешься — ставь 0.4.
<0.3 = generic мотивация, общие советы, не по теме AI/dev/automation.
Если больше 2 items выше 0.7 — пересмотри вниз.
СТЕК-ТЕСТ перед оценкой: спроси себя "мы используем это прямо сейчас?" Если нет → не выше 0.4.
BAD SCORING (реальные ошибки): "VO3 vs Copilot сравнение" → 0.5 НЕВЕРНО (generic tool comparison, не наш стек) → правильно 0.35. "Next.js SSR вместо Vite" → 0.5 НЕВЕРНО (мы уже на Vite, смена стека не планируется) → правильно 0.3. "Monolith vs microservices" → 0.5 НЕВЕРНО (абстрактная архитектура) → правильно 0.35.
ПРИМЕРЫ <0.3: "Мотивационное видео про успех предпринимателя" → 0.1. "Обзор 10 AI инструментов без конкретики про наш стек" → 0.2. "Как стать продуктивным за 5 шагов" → 0.1. "Python фреймворк для ML" → 0.25 (не наш стек совсем).
IDEAS — СТРОГО: ПЕРЕД созданием idea проверь: это ДЕЙСТВИЕ или ОПИСАНИЕ? Если можно убрать все глаголы и смысл не изменится → это описание → НЕ создавай idea. Идея ОБЯЗАНА отвечать на вопрос ЧТО СДЕЛАТЬ, не ЧТО ЭТО ТАКОЕ.
idea ОБЯЗАНА начинаться с глагола действия (Добавить/Подключить/Настроить/Мигрировать/Внедрить/Использовать). Если idea не начинается с глагола → это НЕ idea, не создавай.
GOOD: "Подключить Playwright MCP к Claude Code для автотестирования Pitstop" | "Добавить Redis для кэширования YouTube metadata в Runner" | "Настроить FastAPI бэкенд вместо Express для Runner"
BAD: "FastAPI + Pydantic даёт автоматическую валидацию" (факт) | "PostgreSQL с JSON покрывает большинство паттернов" (описание) | "Playwright MCP — интеграция для Claude Code" (определение) | "Redis — кэш для высоконагруженных систем" (описание инструмента)
ТЕСТ: если можно добавить "— Википедия" в конец и звучит нормально → это НЕ idea. Не создавай.
Если idea = пересказ knowledge → НЕ создавай idea.
ALREADY USING — НЕ создавать ideas "используй X" если X уже в списке: Claude/Claude Code/Claude Haiku, Supabase, Vercel, React+Vite+TypeScript+Tailwind, Node.js+Express, Apify instagram-scraper, Groq Whisper, pgvector, Telegram Bot API, OpenAI text-embedding-3-small. Допустимо только НОВОЕ использование: "Добавить Supabase Realtime для live updates" — ок. "Использовать Supabase для базы данных" — НЕТ.
RESOURCES: If the content mentions specific tools, services, or repositories — add one extra item with t="tool" and content = name + URL (if available) + one sentence what it does. Only for concrete tools, not generic concepts.
ENTITIES: e[] and eo[] — ONLY proper nouns: имена инструментов (Sentry, Supabase), проектов (MAOS, Pitstop), людей, компаний. NEVER: "мониторинг", "автоматизация", "AI", "фреймворк", "serverless", "error handling", "batch processing".
ENTITY CONTAMINATION: Extract tools/people/companies mentioned IN THE ARTICLE TEXT. Do NOT add MAOS, MAOS Runner, MAOS Intake, MAOS Brain, Railway, Pitstop as entities unless the article ACTUALLY DISCUSSES them by name. A Discord bot article must NOT have entity "MAOS Runner". A Dart article must NOT have entity "MAOS Brain".
ITEM LIMIT: Do NOT generate more than 10 knowledge items per article. If the article genuinely has only 2 real insights — return 2. Do not pad to reach 10.
ENTITY RELATIONSHIPS: er[] — for each meaningful entity pair, specify relationship: uses, built_with, competes_with, part_of, created_by, implements, related_to. Format: [{"s":"Entity1","t":"Entity2","r":"uses"}]. Max 5 relationships per item. Only include when entities have a clear directional relationship.
BATCH MODE: If the text contains multiple separate posts/messages (separated by ---, ===, or double newline + numbering), analyze EACH post separately. Extract insights from EACH post independently. Small posts may have 1-2 insights, large posts 5-8.

EXAMPLES OF HIGH-QUALITY OUTPUT (use as reference for format, score calibration, entity extraction):

Example 1 — tool article (score 0.9):
Input: Article about QMD, a semantic search tool for Obsidian combining BM25 + vector search, results in <1s vs 2-3 min brute-force.
Output item: {"t":"tool","c":"QMD — семантический поисковик для Obsidian vault, комбинирует BM25 и vector semantic search. Результаты за <1 сек вместо 2-3 минут при brute-force поиске через Claude.","b":"Мгновенное восстановление контекста между сессиями, экономия токенов и улучшение качества recall.","s":0.95,"r":0.9,"e":["QMD","Obsidian"],"eo":[{"n":"QMD","t":"tool"},{"n":"Obsidian","t":"tool"}]}
Why score 0.9: конкретный инструмент, прямо релевантен нашему knowledge pipeline, реализуемо за 1-2 дня.

Example 2 — architecture insight (score 0.6):
Input: Article about OpenRouter as unified API for LLM providers (Claude, GPT, Gemini) with pay-as-you-go.
Output item: {"t":"tool","c":"OpenRouter — единый API для множества LLM-моделей (Claude, GPT, Gemini) с pay-as-you-go. Позволяет переключаться между моделями без переписания интеграций.","b":"Ускоряет разработку агентов MAOS и снижает vendor lock-in для AI оркестрации.","s":0.95,"r":0.9,"e":["OpenRouter"],"eo":[{"n":"OpenRouter","t":"tool"}]}
Why score 0.9: прямо релевантен нашему стеку (Claude/Haiku уже используем), actionable this week.

Example 3 — generic insight (score 0.35):
Input: Article about dual thinking in design — balancing analytics vs empathy, business vs user.
Output item: {"t":"insight","c":"Дуалистическое мышление — способность удерживать противоположные требования (аналитика vs эмпатия, бизнес vs пользователь) без выбора одной крайности. Применимо при проектировании API и UX решений.","b":"Помогает принимать сбалансированные архитектурные решения в MAOS.","s":0.3,"r":0.35,"e":[],"eo":[]}
Why score 0.35: полезно стратегически, но не наш стек напрямую — дефолтная зона 0.3-0.5.`;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseHaikuJSON(raw: string): any {
  let text = raw.trim();

  // 1. Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '');
  text = text.replace(/\s*```\s*$/i, '');
  text = text.trim();

  // 2. Remove control chars EXCEPT \n (0x0A), \r (0x0D), \t (0x09) — preserve JSON structural whitespace
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // 3. Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // 4. Extract outermost {...} and try again
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        console.error('[HAIKU] Parse failed after extraction:', msg);
        console.error('[HAIKU] First 200 chars:', text.slice(0, 200));
      }
    }
    return { items: [], summary: '', category: 'parse_error' };
  }
}

interface CompactItem {
  t: string;
  c: string;
  b: string;
  s: number;
  r: number;
  e?: string[];
  eo?: { n: string; t: string }[];
  er?: { s: string; t: string; r: string }[];
}

interface CompactResponse {
  items: CompactItem[];
  summary: string;
  entities?: string[];
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
      tags: item.e ?? [],
      entity_objects: (item.eo ?? []).map((o) => ({
        name: o.n,
        type: (['tool', 'project', 'concept', 'person'].includes(o.t) ? o.t : 'concept') as EntityObject['type'],
      })),
      entity_relationships: (item.er ?? []).map((rel): EntityRelationship => {
        const validTypes: EntityRelationshipType[] = ['uses', 'built_with', 'competes_with', 'part_of', 'created_by', 'implements', 'related_to'];
        return {
          source: rel.s,
          target: rel.t,
          relationship: (validTypes.includes(rel.r as EntityRelationshipType) ? rel.r : 'related_to') as EntityRelationshipType,
        };
      }),
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
    entities: parsed.entities ?? [],
  };
}

const MAX_CHARS_FOR_HAIKU = 12000;
const MAX_CHUNK_CHARS = 3000;
const CHUNK_OVERLAP_CHARS = 200;
const CHUNKING_THRESHOLD = 4000; // chars
const MAX_CHUNKS = 20;

export async function analyzeWithChunking(text: string, source: string): Promise<BrainAnalysis> {
  if (text.length <= CHUNKING_THRESHOLD) {
    return analyzeContent(text, source, false);
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS) {
    chunks.push(text.slice(i, i + MAX_CHUNK_CHARS));
    if (chunks.length >= MAX_CHUNKS) break;
  }
  console.log(`[CHUNKING] ${text.length} chars → ${chunks.length} chunks`);

  const allItems: KnowledgeItem[] = [];
  let firstSummary = '';
  let maxImmediate = 0;
  let maxStrategic = 0;
  let prioritySignal = false;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[CHUNKING] chunk ${i + 1}/${chunks.length}`);
    try {
      const result = await analyzeContent(chunks[i], source, true);
      allItems.push(...result.knowledge_items);
      if (i === 0) firstSummary = result.summary;
      maxImmediate = Math.max(maxImmediate, result.overall_immediate);
      maxStrategic = Math.max(maxStrategic, result.overall_strategic);
      if (result.priority_signal) prioritySignal = true;
    } catch (e) {
      console.error(`[CHUNKING] chunk ${i + 1} failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  const aggregated: BrainAnalysis = {
    summary: firstSummary || `Обработано ${chunks.length} частей, извлечено ${allItems.length} знаний`,
    knowledge_items: allItems,
    overall_immediate: maxImmediate,
    overall_strategic: maxStrategic,
    priority_signal: prioritySignal,
    priority_reason: '',
    category: 'other',
    language: 'other',
  };

  if (prioritySignal) {
    await sendTelegramAlert(source, aggregated);
  }

  return aggregated;
}

export async function analyzeContent(text: string, source: string, isChunk = false): Promise<BrainAnalysis> {
  // Token estimation upstream guard — before expensive truncation logic
  const estimatedTokens = Math.ceil(text.length / 4);
  console.log(`[extraction] estimated tokens: ${estimatedTokens}`);
  if (estimatedTokens > 10000) text = text.slice(0, 40000);

  const trimmedText = text.length > MAX_CHARS_FOR_HAIKU
    ? text.substring(0, MAX_CHARS_FOR_HAIKU) + '\n[...текст обрезан...]'
    : text;

  // Language pre-filter — skip content with no recognizable script
  const cyrillicRatio = (trimmedText.match(/[а-яА-ЯёЁ]/g) ?? []).length / trimmedText.length;
  const latinRatio = (trimmedText.match(/[a-zA-Z]/g) ?? []).length / trimmedText.length;
  if (cyrillicRatio < 0.05 && latinRatio < 0.05) {
    console.log(`[ANALYZE] skipping unknown_language content (cyrillic=${cyrillicRatio.toFixed(3)} latin=${latinRatio.toFixed(3)})`);
    return {
      summary: '',
      knowledge_items: [],
      overall_immediate: 0,
      overall_strategic: 0,
      priority_signal: false,
      priority_reason: 'unknown_language',
      category: 'skipped',
      language: 'other',
    };
  }

  const context = await getFullContext();
  const trimmedContext = buildContextString(context);

  const maxItems = isChunk ? 5 : (trimmedText.length < 3000 ? 8 : 5);
  console.log(`[ANALYZE] text length: ${trimmedText.length} chars, isChunk: ${isChunk} → maxItems: ${maxItems}`);

  const userPrompt = `Content to analyze:
"""
${trimmedText}
"""
Context about the user's projects and priorities:
"""
${trimmedContext}
"""
Extract MAX ${maxItems} most important insights as JSON. CONCISE, no ads, only actionable insights.

{
  "items": [
    {
      "t": "insight type: insight|pattern|tool|lesson|idea|technique",
      "c": "Insight content. Max 2 sentences.",
      "b": "Business value. 1 sentence.",
      "s": 0.7,
      "r": 0.5,
      "e": ["EntityName", "ToolName"],
      "eo": [{"n": "EntityName", "t": "tool|project|concept|person"}],
      "er": [{"s": "Entity1", "t": "Entity2", "r": "uses|built_with|competes_with|part_of|created_by|implements|related_to"}]
    }
  ],
  "summary": "3 sentence summary of entire content.",
  "entities": ["Supabase", "Claude Code", "MAOS"]
}`;

  // 2048 per CLAUDE.md spec — 5-8 items × ~200 tokens each requires headroom
  const EXTRACTION_MAX_TOKENS = 2048;
  console.log(`[INTAKE] Haiku extraction call: max_tokens=${EXTRACTION_MAX_TOKENS}, prompt_len=${userPrompt.length}`);
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: EXTRACTION_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  const cost = (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;
  console.log(`[INTAKE] Haiku cost: $${cost.toFixed(4)} (in:${inputTokens} out:${outputTokens} max:${EXTRACTION_MAX_TOKENS})`);

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  console.log('[HAIKU] Raw response first 200 chars:', raw.slice(0, 200));

  // Circuit breaker: empty or near-empty response — do NOT retry, do NOT save
  if (raw.trim().length < 20) {
    consecutiveEmptyResponses++;
    await logQuarantine(source, 'empty_response');
    if (consecutiveEmptyResponses >= CIRCUIT_BREAKER_THRESHOLD) {
      const alertText = `⚠️ Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} empty LLM responses in a row. Pipeline halted.`;
      console.error(`[CIRCUIT_BREAKER] ${alertText}`);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: alertText }),
        }).catch(() => { /* non-blocking */ });
      }
      const err = new Error(alertText) as Error & { circuitBreaker: true };
      err.circuitBreaker = true;
      throw err;
    }
    return {
      summary: 'empty_response',
      knowledge_items: [],
      overall_immediate: 0,
      overall_strategic: 0,
      priority_signal: false,
      priority_reason: 'empty_response',
      category: 'empty_response',
      language: 'other',
    };
  }
  consecutiveEmptyResponses = 0; // reset on valid response

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compact = parseHaikuJSON(raw) as any;

  console.log('[ANALYZE] Parsed result keys:', Object.keys(compact));
  console.log('[ANALYZE] Items count:', compact?.items?.length ?? 0);

  if (compact?.category === 'parse_error' || !Array.isArray(compact?.items)) {
    console.error('[HAIKU] JSON parse failed, raw (first 300):', raw.slice(0, 300));
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

  const compactTyped = compact as CompactResponse;

  const analysis = expandCompactResponse(compactTyped);

  if (analysis.priority_signal && !isChunk) {
    await sendTelegramAlert(source, analysis);
  }

  return analysis;
}
