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
      "tags": ["Tag-Specific-To-This-Point"],
      "entities": [{"name": "ToolName", "type": "tool|project|person|concept"}]
    }
  ],
  "actionable_ideas": [
    {
      "c": "Implement: specific action with specific tool",
      "tags": ["Tag-Specific-To-This-Idea"],
      "entities": [{"name": "ToolName", "type": "tool"}]
    }
  ],
  "relevance_score": 0.8
}

QUANTITY RULES:
- Extract ALL valuable insights from the video. Do NOT limit to a fixed number.
- Short video (< 5 min) → typically 1-3 insights.
- Long detailed video (> 30 min) → may have 15-30 insights.
- Do NOT pad with filler. Do NOT skip real insights to fit a number.
- Each item must be a concrete actionable technique or fact, not a summary.

PER-ITEM TAGS AND ENTITIES:
- Each insight MUST have its OWN tags and entities specific to THAT point.
- BAD: all items have tags ["LangGraph","Claude","Tavily","AI-Orchestration"]
- GOOD example — video about LangGraph multi-agent:
  Item 1: { c: "Tavily Search API дает структурированные данные для LLM", tags: ["Tavily","Search-API"], entities: [{"name":"Tavily","type":"tool"}] }
  Item 2: { c: "Supervisor pattern снижает галлюцинации в multi-agent", tags: ["Multi-Agent","Supervisor-Pattern"], entities: [{"name":"LangGraph","type":"tool"}] }
  Item 3: { c: "PostgreSQL checkpoints включают async workflows", tags: ["PostgreSQL","State-Management"], entities: [{"name":"PostgreSQL","type":"tool"},{"name":"Supabase","type":"tool"}] }

QUALITY RULES:
- BAD insight: "Видео рассматривает подходы к автоматизации"
- GOOD insight: "pgvector HNSW index 10x faster than IVFFlat for vectors under 1M"
- Tags: 1-3 per item, specific — "Supabase Edge Functions" not "technology"
- Entities: proper nouns only — tools, projects, people. NEVER: "AI", "фреймворк", "мониторинг"
- Ideas must start with verb: Добавить/Настроить/Мигрировать/Внедрить
- SCORING: 0.8+ = actionable this week with Node.js/TS/Supabase/Claude/Vercel stack. 0.5–0.7 = strategic. <0.3 = generic/off-topic
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

  // key_insights: array of {c, tags, entities} objects (new format)
  // or fallback to string[] (old format)
  type InsightItem = { c?: string; tags?: string[]; entities?: unknown[] } | string;
  const insights: KnowledgeItem[] = (parsed.key_insights ?? []).map((item: InsightItem): KnowledgeItem => {
    const isObj = typeof item === 'object' && item !== null;
    const content = isObj ? ((item as { c?: string }).c ?? '') : (item as string);
    const itemTags: string[] = isObj ? ((item as { tags?: string[] }).tags ?? []) : [];
    const itemEntities = toEntityObjects(isObj ? ((item as { entities?: unknown[] }).entities ?? []) : []);
    return {
      knowledge_type: 'insight' as KnowledgeType,
      content,
      business_value: null,
      strategic_relevance: score * 0.85,
      immediate_relevance: score,
      project: null,
      domains: itemTags,
      solves_need: null,
      novelty: 0.6,
      effort: 'medium' as EffortLevel,
      has_ready_code: false,
      tags: itemTags,
      entity_objects: itemEntities,
    };
  });

  type IdeaItem = { c?: string; tags?: string[]; entities?: unknown[] } | string;
  const ideas: KnowledgeItem[] = (parsed.actionable_ideas ?? []).map((item: IdeaItem): KnowledgeItem => {
    const isObj = typeof item === 'object' && item !== null;
    const content = isObj ? ((item as { c?: string }).c ?? '') : (item as string);
    const itemTags: string[] = isObj ? ((item as { tags?: string[] }).tags ?? []) : [];
    const itemEntities = toEntityObjects(isObj ? ((item as { entities?: unknown[] }).entities ?? []) : []);
    return {
      knowledge_type: 'actionable_idea' as KnowledgeType,
      content,
      business_value: null,
      strategic_relevance: score,
      immediate_relevance: score,
      project: null,
      domains: itemTags,
      solves_need: null,
      novelty: 0.6,
      effort: 'medium' as EffortLevel,
      has_ready_code: false,
      tags: itemTags,
      entity_objects: itemEntities,
    };
  });

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
  console.log(`[GEMINI] Extracted ${analysis.knowledge_items.length} items, score: ${analysis.overall_immediate.toFixed(2)}, relevant: ${parsed.relevant}`);
  return analysis;
}
