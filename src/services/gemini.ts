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
  "key_insights": ["Concrete technique or finding — max 6"],
  "entities": [{"name": "ToolName", "type": "tool|project|person|concept"}],
  "actionable_ideas": ["Implement: specific action with specific tool — max 4"],
  "tags": ["specific-tag"],
  "relevance_score": 0.8
}

QUALITY RULES:
- BAD: "Видео рассматривает подходы к автоматизации"
- GOOD: "pgvector HNSW index 10x faster than IVFFlat for vectors under 1M"
- Tags: specific — "Supabase Edge Functions" not "technology"
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
  const tags: string[] = Array.isArray(parsed.tags) ? parsed.tags : [];
  const entityObjects: EntityObject[] = (parsed.entities ?? []).map(
    (e: { name: string; type: string }): EntityObject => ({
      name: e.name,
      type: (['tool', 'project', 'concept', 'person'].includes(e.type)
        ? e.type
        : 'concept') as EntityObject['type'],
    }),
  );

  const insights: KnowledgeItem[] = (parsed.key_insights ?? []).map((c: string): KnowledgeItem => ({
    knowledge_type: 'insight' as KnowledgeType,
    content: c,
    business_value: null,
    strategic_relevance: score * 0.85,
    immediate_relevance: score,
    project: null,
    domains: tags,
    solves_need: null,
    novelty: 0.6,
    effort: 'medium' as EffortLevel,
    has_ready_code: false,
    tags,
    entity_objects: entityObjects,
  }));

  const ideas: KnowledgeItem[] = (parsed.actionable_ideas ?? []).map((c: string): KnowledgeItem => ({
    knowledge_type: 'actionable_idea' as KnowledgeType,
    content: c,
    business_value: null,
    strategic_relevance: score,
    immediate_relevance: score,
    project: null,
    domains: tags,
    solves_need: null,
    novelty: 0.6,
    effort: 'medium' as EffortLevel,
    has_ready_code: false,
    tags,
    entity_objects: [],
  }));

  const knowledge_items = [...insights, ...ideas];

  return {
    summary: parsed.summary ?? '',
    knowledge_items,
    overall_immediate: score,
    overall_strategic: score * 0.85,
    priority_signal: score >= 0.8,
    priority_reason: '',
    category: 'video',
    language: 'ru',
    entities: (parsed.entities ?? []).map((e: { name: string }) => e.name),
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
