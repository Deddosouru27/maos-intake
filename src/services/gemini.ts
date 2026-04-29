import { BrainAnalysis, KnowledgeItem, KnowledgeType, EntityObject, EffortLevel } from '../types';

// gemini-2.5-flash via REST v1beta — free tier: 250 videos/day, 10 RPM.
// SDK dropped: direct REST gives full control over model name and error codes.
const MODEL_ID = 'gemini-3-flash-preview'; // YouTube fileData requires gemini-3+
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You are MAOS knowledge extraction engine.
Analyze this YouTube video.
Owner interests: AI agents, automation, SaaS, TypeScript, Supabase, Node.js, Claude/LLMs, Vercel, Telegram bots.
If NOT relevant → return {"relevant": false, "reason": "one sentence why"}

Return ONLY valid JSON, no markdown:
{
  "relevant": true,
  "full_transcript": "500+ word detailed summary of everything said in the video",
  "summary": "One specific sentence about the core value",
  "key_insights": [
    {
      "c": "Concrete technique or fact — one specific actionable sentence",
      "score": 0.75,
      "tags": ["Tag-Specific-To-This-Point"],
      "entities": [{"name": "ToolName", "type": "tool|project|person|concept"}]
    }
  ],
  "actionable_ideas": [
    {
      "c": "Implement: specific action with specific tool",
      "score": 0.8,
      "tags": ["Tag-Specific-To-This-Idea"],
      "entities": [{"name": "ToolName", "type": "tool"}]
    }
  ],
  "relevance_score": 0.8
}

QUANTITY RULES:
- Extract ALL genuinely valuable insights. Do NOT pad to reach a number.
- Short 3-min video = 1-3 items. Long 1.5-hour lecture = 15-30 items.
- Do NOT skip real insights to stay under a number.
- Each item must be a CONCRETE technique or fact, not a rephrased summary.

PER-ITEM TAGS AND ENTITIES:
- Each insight MUST have its OWN tags (1-3) specific to THAT point.
- Do NOT copy video-level tags to every item.
- BAD: all 10 items have tags ["LangGraph","Claude","Tavily"]
- GOOD: item about checkpoints → ["State-Management","PostgreSQL"], item about Tavily → ["Search-API","Tavily"]

ENTITY CONTAMINATION RULE:
- Extract tools, people, companies mentioned IN THE VIDEO CONTENT.
- Do NOT add MAOS, MAOS Runner, MAOS Intake, MAOS Brain, Railway, Pitstop as entities
  unless the video ACTUALLY DISCUSSES them by name.
- A LangGraph tutorial must NOT have entity "MAOS Runner".
- A Python ML video must NOT have entity "Supabase".

SCORING — be HARSH. Score EACH item by its specific content, NOT the video overall.

0.95-1.0: REVOLUTIONARY — changes how we build, extremely rare. At most 1 item per video can ever score here. If you gave multiple 0.9+ scores, you are wrong — reassess all of them.
0.8-0.94: Step-by-step for our EXACT stack (Node.js, TypeScript, Supabase, Telegram bots, Claude, Vercel). Usable this week without significant adaptation.
0.7-0.79: Relevant to AI/automation but needs adaptation. Useful concept, different language or platform.
0.5-0.69: Interesting concept, not directly applicable. Generic architecture, non-stack technique.
0.3-0.49: Tangentially related. Background knowledge. Vaguely relevant tool.
0.0-0.29: Not relevant — OMIT items below 0.3, do not include them at all.

DISTRIBUTION RULE: In a typical 20-30 min video expect: 0-1 items at 0.9+, 1-3 items at 0.7-0.89, several items at 0.5-0.69, rest below 0.5. If your output is dominated by 0.9+ scores you are miscalibrated.

FEW-SHOT SCORING EXAMPLES:
- "pgvector HNSW index cuts query time 10x vs IVFFlat for vectors under 1M" → 0.85 (Supabase+pgvector = our exact stack, directly usable)
- "LangGraph supervisor pattern coordinates multiple agents with shared state" → 0.72 (useful concept, Python-specific details irrelevant to us)
- "Python pip install + virtualenv setup for LangGraph" → 0.22 (omit — we use TypeScript, setup steps useless)
- "Monolith vs microservices trade-offs for early-stage startups" → 0.38 (generic architecture, not our immediate concern)
- "Playwright MCP integration for Claude Code enables browser automation" → 0.91 (directly applicable to Claude Code we use daily)
- "Vercel Edge Middleware intercepts requests before function invocation" → 0.87 (Vercel = our deploy platform, usable this week)

- BAD insight: "Видео рассматривает подходы к автоматизации"
- GOOD insight: "pgvector HNSW index 10x faster than IVFFlat for vectors under 1M"
- Entities: proper nouns only. NEVER: "AI", "фреймворк", "мониторинг", "автоматизация"
- Ideas must start with verb: Добавить/Настроить/Мигрировать/Внедрить
- All text content in Russian.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGeminiJSON(raw: string): any {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

function buildBrainAnalysis(parsed: ReturnType<typeof parseGeminiJSON>): BrainAnalysis {
  // Not relevant — return empty analysis so pipeline discards it
  if (!parsed.relevant) {
    return {
      summary: parsed.reason ?? 'Not relevant to MAOS stack',
      knowledge_items: [],
      overall_immediate: 0,
      overall_strategic: 0,
      priority_signal: false,
      priority_reason: '',
      category: 'not_relevant',
      language: 'ru',
    };
  }

  const score: number = typeof parsed.relevance_score === 'number' ? parsed.relevance_score : 0.5;

  function toEntityObjects(raw: unknown[]): EntityObject[] {
    return raw.map((e: unknown): EntityObject => {
      const obj = e as { name?: string; type?: string };
      return {
        name: obj.name ?? '',
        type: (['tool', 'project', 'concept', 'person'].includes(obj.type ?? '')
          ? obj.type
          : 'concept') as EntityObject['type'],
      };
    }).filter((e) => e.name);
  }

  // key_insights / actionable_ideas: {c, score?, tags, entities} or string fallback
  type InsightItem = { c?: string; score?: number; tags?: string[]; entities?: unknown[] } | string;

  function toItem(item: InsightItem, type: KnowledgeType): KnowledgeItem | null {
    const isObj = typeof item === 'object' && item !== null;
    const content = isObj ? ((item as { c?: string }).c ?? '') : (item as string);
    if (!content.trim()) return null;
    const itemScore = isObj ? ((item as { score?: number }).score ?? score) : score;
    if (itemScore < 0.3) return null; // Omit low-relevance items
    const itemTags: string[] = isObj ? ((item as { tags?: string[] }).tags ?? []) : [];
    const itemEntities = toEntityObjects(isObj ? ((item as { entities?: unknown[] }).entities ?? []) : []);
    return {
      knowledge_type: type,
      content,
      business_value: null,
      strategic_relevance: itemScore * 0.85,
      immediate_relevance: itemScore,
      project: null,
      domains: itemTags,
      solves_need: null,
      novelty: 0.6,
      effort: 'medium' as EffortLevel,
      has_ready_code: false,
      tags: itemTags,
      entity_objects: itemEntities,
    };
  }

  const insights: KnowledgeItem[] = ((parsed.key_insights ?? []) as InsightItem[])
    .map((i) => toItem(i, 'insight' as KnowledgeType))
    .filter((i): i is KnowledgeItem => i !== null);

  const ideas: KnowledgeItem[] = ((parsed.actionable_ideas ?? []) as InsightItem[])
    .map((i) => toItem(i, 'actionable_idea' as KnowledgeType))
    .filter((i): i is KnowledgeItem => i !== null);

  const knowledge_items = [...insights, ...ideas];

  // Collect all unique entity names for the top-level entities field
  const allEntityNames = [...new Set(knowledge_items.flatMap((i) => i.entity_objects?.map((e) => e.name) ?? []))];

  return {
    summary: parsed.summary ?? '',
    knowledge_items,
    overall_immediate: score,
    overall_strategic: score * 0.85,
    priority_signal: score >= 0.8,
    priority_reason: '',
    category: 'video',
    language: 'ru',
    entities: allEntityNames,
    // Store full_transcript in _haiku_raw so it gets saved to ingested_content.haiku_raw_response
    _haiku_raw: parsed.full_transcript ?? undefined,
  };
}

export async function analyzeYouTubeWithGemini(url: string): Promise<BrainAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const endpoint = `${API_BASE}/${MODEL_ID}:generateContent?key=${apiKey}`;
  console.log('[GEMINI] Analyzing YouTube URL:', url);

  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        parts: [
          { text: `Analyze this YouTube video: ${url}\n\nExtract knowledge for MAOS.` },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Gemini network error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 429 — quota exceeded, do NOT retry. Caller will mark as failed with reason='gemini_quota'.
  if (response.status === 429) {
    console.error('[GEMINI] 429 quota exceeded for:', url);
    throw new Error('GEMINI_QUOTA_EXCEEDED: free tier rate limit hit, retry later');
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const json = await response.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  console.log('[GEMINI] Raw response first 200 chars:', raw.slice(0, 200));

  if (!raw || raw.trim().length < 20) {
    throw new Error('Gemini returned empty response');
  }

  const parsed = parseGeminiJSON(raw);
  if (!parsed) {
    console.error('[GEMINI] JSON parse failed, raw (first 300):', raw.slice(0, 300));
    throw new Error('Gemini returned invalid JSON');
  }

  const analysis = buildBrainAnalysis(parsed);

  // Entity contamination guard: validate against full_transcript + blacklist
  const transcriptLower = (parsed.full_transcript ?? '').toLowerCase();
  const MAOS_BLACKLIST = new Set([
    'maos', 'pitstop', 'runner', 'intake', 'autorun', 'intaker',
    'brainstormer', 'maos-runner', 'maos-intake', 'maos-brain', 'nout', 'pekar', 'lama',
  ]);
  let totalEntityDrops = 0;
  for (const item of analysis.knowledge_items) {
    if (!item.entity_objects?.length) continue;
    const before = item.entity_objects.length;
    item.entity_objects = item.entity_objects.filter((e) => {
      const nameLower = e.name.toLowerCase();
      if (MAOS_BLACKLIST.has(nameLower)) return false;
      // Only validate against transcript if we have one (>50 chars)
      if (transcriptLower.length > 50) return transcriptLower.includes(nameLower);
      return true;
    });
    totalEntityDrops += before - item.entity_objects.length;
  }
  if (totalEntityDrops > 0) {
    console.log(`[GEMINI] Dropped ${totalEntityDrops} phantom entities not in transcript`);
  }

  console.log(`[GEMINI] Extracted ${analysis.knowledge_items.length} items, score: ${analysis.overall_immediate.toFixed(2)}, relevant: ${parsed.relevant}`);
  return analysis;
}

/** Text-only Gemini call — reuses same REST infra, model gemini-2.5-flash (free tier). */
export async function callGeminiForText(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const TEXT_MODEL = 'gemini-2.0-flash'; // 2.5-flash preview unstable for text; 2.0 is stable
  const endpoint = `${API_BASE}/${TEXT_MODEL}:generateContent?key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
    });
  } catch (e) {
    throw new Error(`Gemini text network error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (response.status === 429) throw new Error('GEMINI_QUOTA_EXCEEDED: rate limit hit');
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini text API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const json = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
