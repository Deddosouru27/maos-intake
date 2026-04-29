import Anthropic from '@anthropic-ai/sdk';
import { ScoredItem } from './score';

export const VARIANT_A_ID = 'baseline_v1';
export const VARIANT_B_ID = 'strict_calibration_v1';

// Variant A: current production extraction prompt
const SYSTEM_PROMPT_A = `CONTEXT: You extract knowledge for MAOS — a personal AI business brain.
Owner interests: AI agents, automation, SaaS, TypeScript/Node.js, Supabase, Telegram bots, knowledge pipelines.
QUALITY RULES:
- Extract ACTIONABLE insights, not summaries. Each insight must be a concrete technique or tool recommendation.
- Tags must be specific: "Supabase Edge Functions" not "technology".
- Entities: only named tools, people, companies, projects — never generic concepts.
- If content is not relevant to AI/tech/business → set all relevance scores < 0.3.
SCORING:
0.8+ = actionable THIS WEEK with current stack
0.5-0.7 = strategically useful, only if directly relevant to stack
0.3-0.5 = default for most content
<0.3 = generic, off-topic

Respond in Russian. Output ONLY valid JSON array:
[{"t":"insight|tool|technique","c":"content","b":"business_value","r":0.4,"e":["Tag1","Tag2"],"eo":[{"n":"Name","t":"tool"}]}]`;

// Variant B: stricter calibration with anti-inflation guard and type diversity requirement
const SYSTEM_PROMPT_B = `CONTEXT: You extract knowledge for MAOS — a personal AI business brain.
Owner interests: AI agents, automation, SaaS, TypeScript/Node.js, Supabase, Telegram bots, knowledge pipelines.
QUALITY RULES:
- Extract ACTIONABLE insights, not summaries. Each insight must be a concrete technique or tool recommendation.
- Tags MUST be specific and ALWAYS include 2-4 per item. "Supabase Edge Functions" not "technology".
- Entities: only named tools, people, companies — NEVER generic concepts like "automation", "AI", "framework".
- MANDATORY: use diverse knowledge types (tool, technique, insight, pattern, lesson) — do NOT use "insight" for everything.
SCORING (STRICT ANTI-INFLATION):
0.8+ = ONLY if actionable this week with current stack (Node.js, TypeScript, Supabase, Claude, Vercel).
0.5-0.7 = strategically useful, ONLY if directly relevant to our stack. Generic comparisons → max 0.4.
0.3-0.5 = DEFAULT. When uncertain, use 0.35 not 0.5.
<0.3 = generic advice, off-topic, motivational content.
ANTI-INFLATION RULE: If mean score across all items > 0.55 — you are inflating. Reduce scores.
ENTITY RULE: At least 80% of items MUST have ≥1 named entity.

Respond in Russian. Output ONLY valid JSON array:
[{"t":"insight|tool|technique|pattern|lesson","c":"content","b":"business_value","r":0.35,"e":["Tag1","Tag2"],"eo":[{"n":"Name","t":"tool"}]}]`;

export interface VariantExtractionResult {
  variantId: string;
  items: ScoredItem[];
  tokens_used: number;
  cost_usd: number;
}

interface RawItem {
  t?: string;
  c?: string;
  b?: string;
  r?: number;
  s?: number;
  e?: unknown[];
  eo?: unknown[];
}

export function parseVariantItems(raw: string): ScoredItem[] {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return (parsed as RawItem[])
    .filter((i) => typeof i.c === 'string' && i.c.length > 0)
    .map((i) => ({
      knowledge_type: typeof i.t === 'string' ? i.t : 'insight',
      content: i.c as string,
      immediate_relevance: typeof i.r === 'number' ? i.r : typeof i.s === 'number' ? i.s : 0.4,
      tags: Array.isArray(i.e) ? (i.e as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      entity_objects: Array.isArray(i.eo)
        ? (i.eo as unknown[])
            .filter((e): e is { n: string; t?: string } => typeof (e as Record<string, unknown>)?.n === 'string')
            .map((e) => ({ name: e.n, type: typeof e.t === 'string' ? e.t : 'tool' }))
        : [],
      business_value: typeof i.b === 'string' ? i.b : null,
    }));
}

export async function runVariant(
  variantId: 'A' | 'B',
  sampleTexts: string[],
  client: Anthropic,
): Promise<VariantExtractionResult> {
  const systemPrompt = variantId === 'A' ? SYSTEM_PROMPT_A : SYSTEM_PROMPT_B;
  const id = variantId === 'A' ? VARIANT_A_ID : VARIANT_B_ID;

  const userPrompt = `Extract knowledge from the following ${sampleTexts.length} text samples. For each sample extract 1-3 high-quality insights. Return all as a single JSON array:\n\n${sampleTexts.map((t, i) => `=== Sample ${i + 1} ===\n${t}`).join('\n\n')}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '[]';
  const usage = response.usage;
  // Haiku 4.5: $0.80/MTok input, $4.00/MTok output, $1.00/MTok cache write, $0.08/MTok cache read
  const cost_usd =
    (usage.input_tokens * 0.8 +
      usage.output_tokens * 4.0 +
      (usage.cache_creation_input_tokens ?? 0) * 1.0 +
      (usage.cache_read_input_tokens ?? 0) * 0.08) /
    1_000_000;

  const items = parseVariantItems(raw);
  return { variantId: id, items, tokens_used: usage.input_tokens + usage.output_tokens, cost_usd };
}
