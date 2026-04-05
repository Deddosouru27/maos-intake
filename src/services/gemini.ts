import { GoogleGenerativeAI } from '@google/generative-ai';
import { BrainAnalysis, KnowledgeItem, KnowledgeType, EffortLevel, EntityObject } from '../types';

// API Cost Protection: max 1 retry. See incident 29.03.
// Gemini free tier — no retry needed; on fail caller falls back to Haiku pipeline.
const MODEL_ID = 'gemini-2.0-flash';

const SYSTEM_PROMPT = `You are a knowledge extraction engine analyzing a YouTube video.
ALWAYS respond in Russian. All content, summary, and insights must be in Russian.
Extract actionable insights relevant to software engineering, AI, automation, developer tools.
SCORING (immediate_relevance r): 0.8+ = actionable this week. 0.5-0.7 = strategic value.
<0.3 = generic motivation, off-topic.
IDEAS: must start with an action verb (Добавить/Настроить/Мигрировать/Внедрить).
ENTITIES: proper nouns only — tool names, projects, people. Never generic concepts.
Return ONLY valid JSON, no markdown.`;

const USER_PROMPT = `Watch this video and extract:
{
  "summary": "2-3 sentence summary in Russian",
  "items": [
    {
      "t": "insight|pattern|tool|lesson|idea|technique",
      "c": "Content in Russian. Max 2 sentences.",
      "b": "Business value in Russian. 1 sentence.",
      "s": 0.6,
      "r": 0.7,
      "e": ["EntityName"],
      "eo": [{"n": "EntityName", "t": "tool|project|concept|person"}]
    }
  ],
  "entities": ["Supabase", "Claude"]
}
Extract MAX 8 most important insights. Focus on actionable knowledge.`;

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
  const validKnowledgeTypes = new Set<KnowledgeType>([
    'actionable_idea', 'tool_or_library', 'architecture_pattern',
    'insight', 'technique', 'lesson_learned',
  ]);
  const typeMap: Record<string, KnowledgeType> = {
    idea: 'actionable_idea', tool: 'tool_or_library', pattern: 'architecture_pattern',
    lesson: 'lesson_learned', insight: 'insight', technique: 'technique',
  };

  const knowledge_items: KnowledgeItem[] = (parsed.items ?? []).map((item: { t: string; c: string; b: string; s: number; r: number; e?: string[]; eo?: {n: string; t: string}[] }) => {
    const kt: KnowledgeType = typeMap[item.t] ?? 'insight';
    if (!validKnowledgeTypes.has(kt)) { /* safe — default is 'insight' */ }
    return {
      knowledge_type: kt,
      content: item.c ?? '',
      business_value: item.b ?? null,
      strategic_relevance: typeof item.s === 'number' ? item.s : 0,
      immediate_relevance: typeof item.r === 'number' ? item.r : 0,
      project: null,
      domains: [],
      solves_need: null,
      novelty: 0.5,
      effort: 'medium' as EffortLevel,
      has_ready_code: false,
      tags: item.e ?? [],
      entity_objects: (item.eo ?? []).map((o: {n: string; t: string}): EntityObject => ({
        name: o.n,
        type: (['tool', 'project', 'concept', 'person'].includes(o.t) ? o.t : 'concept') as EntityObject['type'],
      })),
    };
  });

  const overall_immediate = knowledge_items.length > 0
    ? knowledge_items.reduce((s, i) => s + i.immediate_relevance, 0) / knowledge_items.length : 0;
  const overall_strategic = knowledge_items.length > 0
    ? knowledge_items.reduce((s, i) => s + i.strategic_relevance, 0) / knowledge_items.length : 0;

  return {
    summary: parsed.summary ?? '',
    knowledge_items,
    overall_immediate,
    overall_strategic,
    priority_signal: knowledge_items.some((i) => i.immediate_relevance >= 0.8),
    priority_reason: '',
    category: 'other',
    language: 'ru',
    entities: parsed.entities ?? [],
  };
}

export async function analyzeYouTubeWithGemini(url: string): Promise<BrainAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL_ID, systemInstruction: SYSTEM_PROMPT });

  console.log('[GEMINI] Analyzing YouTube URL:', url);

  // Gemini natively supports YouTube URLs via fileData (Gemini 1.5+)
  const result = await model.generateContent([
    {
      fileData: {
        mimeType: 'video/*',
        fileUri: url,
      },
    },
    { text: USER_PROMPT },
  ]);

  const raw = result.response.text();
  console.log('[GEMINI] Raw response first 200 chars:', raw.slice(0, 200));

  if (!raw || raw.trim().length < 20) {
    throw new Error('Gemini returned empty response');
  }

  const parsed = parseGeminiJSON(raw);
  if (!parsed || !Array.isArray(parsed.items)) {
    console.error('[GEMINI] JSON parse failed, raw (first 300):', raw.slice(0, 300));
    throw new Error('Gemini returned invalid JSON');
  }

  const analysis = buildBrainAnalysis(parsed);
  console.log(`[GEMINI] Extracted ${analysis.knowledge_items.length} items, immediate: ${analysis.overall_immediate.toFixed(2)}`);
  return analysis;
}
