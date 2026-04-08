/**
 * Unit tests for 5 critical pipeline functions.
 * Pure functions replicated from source — no external deps.
 */
import { describe, it, expect } from 'vitest';

// ── Replicated pure functions ─────────────────────────────────────────────────

// From analyze.ts: expandCompactResponse
type KnowledgeType =
  | 'actionable_idea' | 'tool_or_library' | 'architecture_pattern'
  | 'insight' | 'technique' | 'lesson_learned' | 'guide' | 'code_snippet' | 'case_study' | 'strategic_idea';
type EffortLevel = 'trivial' | 'low' | 'medium' | 'high' | 'huge';
type EntityRelationshipType = 'uses' | 'built_with' | 'competes_with' | 'part_of' | 'created_by' | 'implements' | 'related_to';

interface EntityObject { name: string; type: 'tool' | 'project' | 'concept' | 'person' }
interface EntityRelationship { source: string; target: string; relationship: EntityRelationshipType }
interface KnowledgeItem {
  knowledge_type: KnowledgeType; content: string; business_value: string | null;
  strategic_relevance: number; immediate_relevance: number; project: string | null;
  domains: string[]; solves_need: string | null; novelty: number; effort: EffortLevel;
  has_ready_code: boolean; tags: string[];
  entity_objects: EntityObject[]; entity_relationships: EntityRelationship[];
}
interface BrainAnalysis {
  summary: string; knowledge_items: KnowledgeItem[];
  overall_immediate: number; overall_strategic: number;
  priority_signal: boolean; priority_reason: string;
  category: string; language: string; entities?: string[];
}
interface CompactItem {
  t: string; c: string; b: string; s: number; r: number;
  e?: string[]; eo?: { n: string; t: string }[]; er?: { s: string; t: string; r: string }[];
}
interface CompactResponse { items: CompactItem[]; summary: string; entities?: string[] }

function expandCompactResponse(parsed: CompactResponse): BrainAnalysis {
  const knowledge_items: KnowledgeItem[] = (parsed.items ?? []).map((item) => {
    const kt: KnowledgeType =
      item.t === 'pattern' ? 'architecture_pattern'
      : item.t === 'tool' ? 'tool_or_library'
      : item.t === 'lesson' ? 'lesson_learned'
      : item.t === 'idea' ? 'actionable_idea'
      : item.t === 'technique' ? 'technique'
      : 'insight';
    const validTypes = ['tool', 'project', 'concept', 'person'];
    const validRelTypes: EntityRelationshipType[] = ['uses', 'built_with', 'competes_with', 'part_of', 'created_by', 'implements', 'related_to'];
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
        type: (validTypes.includes(o.t) ? o.t : 'concept') as EntityObject['type'],
      })),
      entity_relationships: (item.er ?? []).map((rel): EntityRelationship => ({
        source: rel.s,
        target: rel.t,
        relationship: (validRelTypes.includes(rel.r as EntityRelationshipType) ? rel.r : 'related_to') as EntityRelationshipType,
      })),
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

// From pitstop.ts: inferRelationship
function inferRelationship(sourceType: string, targetType: string): EntityRelationshipType {
  const key = `${sourceType}+${targetType}`;
  switch (key) {
    case 'tool+tool': return 'competes_with';
    case 'person+tool': return 'uses';
    case 'tool+person': return 'created_by';
    case 'tool+concept': return 'implements';
    case 'concept+tool': return 'implements';
    case 'person+project': return 'created_by';
    case 'project+tool': return 'built_with';
    case 'tool+project': return 'built_with';
    default: return 'related_to';
  }
}

// From pitstop.ts: generateIdeaText
function generateIdeaText(content: string): string {
  const clean = content.replace(/^\[GUIDE\]\s*/, '').trim();
  const firstSentence = clean.split(/[.!?]\s/)[0] ?? clean;
  const truncated = firstSentence.length > 200 ? firstSentence.slice(0, 200) + '…' : firstSentence;
  const verbPrefixes = ['добавить', 'настроить', 'мигрировать', 'внедрить', 'implement', 'add', 'configure', 'integrate'];
  const startsWithVerb = verbPrefixes.some(v => truncated.toLowerCase().startsWith(v));
  if (startsWithVerb) return truncated;
  return `Внедрить: ${truncated}`;
}

// From projectContext.ts: buildContextString
interface ProjectContext { name: string; description: string; current_needs: string | null; tech_stack: string[] | null; current_focus: string | null; long_term_goals: string | null }
interface DomainContext { name: string; description: string; priority: number; examples: string[] | null }
interface TaskContext { title: string }
interface FullContext { projects: ProjectContext[]; domains: DomainContext[]; tasks: TaskContext[]; recentHashes: string[] }

const MAX_CONTEXT = 800;

function buildContextString(context: FullContext): string {
  const parts: string[] = [];
  if (context.projects.length > 0) {
    const projects = context.projects.map((p) => {
      const bits = [p.name];
      if (p.current_focus) bits.push(`focus: ${p.current_focus}`);
      if (p.current_needs) bits.push(`needs: ${p.current_needs}`);
      return bits.join(' — ');
    }).join('; ');
    parts.push(`Projects: ${projects}`);
  }
  if (context.domains.length > 0) {
    const domains = [...context.domains].sort((a, b) => b.priority - a.priority).map((d) => d.name).join(', ');
    parts.push(`Domains: ${domains}`);
  }
  if (context.tasks.length > 0) {
    const tasks = context.tasks.slice(0, 5).map((t) => t.title).join('; ');
    parts.push(`Active tasks: ${tasks}`);
  }
  const result = parts.join('\n');
  return result.length > MAX_CONTEXT ? result.substring(0, MAX_CONTEXT) : result;
}

// From index.ts: buildNotification
type RoutedTo = 'hot_backlog' | 'knowledge_base' | 'discarded';
interface RoutedKnowledgeItem { routed_to: RoutedTo }

function buildNotification(routed: RoutedKnowledgeItem[]): string {
  const hot = routed.filter((i) => i.routed_to === 'hot_backlog').length;
  const strategic = routed.filter((i) => i.routed_to === 'knowledge_base').length;
  if (hot > 0) return `🔥 ${hot} идей для текущих задач`;
  if (strategic > 0) return `📚 ${strategic} знаний сохранено в базу`;
  return '📭 Нерелевантен для наших направлений';
}

// ── 1. expandCompactResponse — LLM compact output → BrainAnalysis ─────────────

describe('expandCompactResponse', () => {
  it('maps compact type codes to full KnowledgeType names', () => {
    const input: CompactResponse = {
      items: [
        { t: 'pattern', c: 'CQRS pattern', b: 'val', s: 0.5, r: 0.4 },
        { t: 'tool', c: 'Sentry SDK', b: 'val', s: 0.6, r: 0.7 },
        { t: 'lesson', c: 'Never retry 5xx', b: 'val', s: 0.3, r: 0.2 },
        { t: 'idea', c: 'Добавить кэш', b: 'val', s: 0.8, r: 0.9 },
        { t: 'technique', c: 'Chunking', b: 'val', s: 0.4, r: 0.3 },
        { t: 'unknown_type', c: 'Fallback', b: 'val', s: 0.2, r: 0.1 },
      ],
      summary: 'Test summary',
    };
    const result = expandCompactResponse(input);
    expect(result.knowledge_items[0].knowledge_type).toBe('architecture_pattern');
    expect(result.knowledge_items[1].knowledge_type).toBe('tool_or_library');
    expect(result.knowledge_items[2].knowledge_type).toBe('lesson_learned');
    expect(result.knowledge_items[3].knowledge_type).toBe('actionable_idea');
    expect(result.knowledge_items[4].knowledge_type).toBe('technique');
    expect(result.knowledge_items[5].knowledge_type).toBe('insight'); // unknown → insight
  });

  it('computes overall scores as averages', () => {
    const input: CompactResponse = {
      items: [
        { t: 'insight', c: 'A', b: 'v', s: 0.6, r: 0.8 },
        { t: 'insight', c: 'B', b: 'v', s: 0.4, r: 0.2 },
      ],
      summary: 'avg test',
    };
    const result = expandCompactResponse(input);
    expect(result.overall_strategic).toBeCloseTo(0.5);
    expect(result.overall_immediate).toBeCloseTo(0.5);
  });

  it('sets priority_signal when any item has immediate_relevance >= 0.8', () => {
    const hot: CompactResponse = {
      items: [{ t: 'insight', c: 'Hot', b: 'v', s: 0.5, r: 0.85 }],
      summary: 'hot',
    };
    const cold: CompactResponse = {
      items: [{ t: 'insight', c: 'Cold', b: 'v', s: 0.5, r: 0.79 }],
      summary: 'cold',
    };
    expect(expandCompactResponse(hot).priority_signal).toBe(true);
    expect(expandCompactResponse(cold).priority_signal).toBe(false);
  });

  it('handles empty items gracefully', () => {
    const result = expandCompactResponse({ items: [], summary: 'empty' });
    expect(result.knowledge_items).toHaveLength(0);
    expect(result.overall_immediate).toBe(0);
    expect(result.overall_strategic).toBe(0);
    expect(result.priority_signal).toBe(false);
  });

  it('normalizes invalid entity object types to concept', () => {
    const input: CompactResponse = {
      items: [{
        t: 'tool', c: 'X', b: 'v', s: 0.5, r: 0.5,
        eo: [{ n: 'Acme', t: 'company' }, { n: 'Bob', t: 'person' }],
      }],
      summary: 'entities',
    };
    const result = expandCompactResponse(input);
    const eos = result.knowledge_items[0].entity_objects;
    expect(eos[0].type).toBe('concept'); // 'company' → 'concept'
    expect(eos[1].type).toBe('person');   // valid
  });

  it('normalizes invalid relationship types to related_to', () => {
    const input: CompactResponse = {
      items: [{
        t: 'tool', c: 'X', b: 'v', s: 0.5, r: 0.5,
        er: [{ s: 'A', t: 'B', r: 'depends_on' }, { s: 'C', t: 'D', r: 'uses' }],
      }],
      summary: 'rels',
    };
    const result = expandCompactResponse(input);
    const rels = result.knowledge_items[0].entity_relationships;
    expect(rels[0].relationship).toBe('related_to'); // invalid → related_to
    expect(rels[1].relationship).toBe('uses');         // valid
  });
});

// ── 2. inferRelationship — entity type pair → relationship type ────────────────

describe('inferRelationship', () => {
  it('tool+tool → competes_with', () => {
    expect(inferRelationship('tool', 'tool')).toBe('competes_with');
  });

  it('person+tool → uses', () => {
    expect(inferRelationship('person', 'tool')).toBe('uses');
  });

  it('tool+person → created_by', () => {
    expect(inferRelationship('tool', 'person')).toBe('created_by');
  });

  it('tool+concept / concept+tool → implements', () => {
    expect(inferRelationship('tool', 'concept')).toBe('implements');
    expect(inferRelationship('concept', 'tool')).toBe('implements');
  });

  it('project+tool / tool+project → built_with', () => {
    expect(inferRelationship('project', 'tool')).toBe('built_with');
    expect(inferRelationship('tool', 'project')).toBe('built_with');
  });

  it('person+project → created_by', () => {
    expect(inferRelationship('person', 'project')).toBe('created_by');
  });

  it('unknown pair → related_to', () => {
    expect(inferRelationship('concept', 'concept')).toBe('related_to');
    expect(inferRelationship('project', 'person')).toBe('related_to');
    expect(inferRelationship('concept', 'person')).toBe('related_to');
  });
});

// ── 3. generateIdeaText — verb prefix + truncation + [GUIDE] strip ─────────────

describe('generateIdeaText', () => {
  it('preserves text that already starts with a valid verb', () => {
    expect(generateIdeaText('Добавить Redis для кэширования')).toBe('Добавить Redis для кэширования');
    expect(generateIdeaText('Настроить мониторинг через Sentry')).toBe('Настроить мониторинг через Sentry');
  });

  it('preserves English verb prefixes', () => {
    expect(generateIdeaText('Implement caching layer')).toBe('Implement caching layer');
    expect(generateIdeaText('Add Sentry integration')).toBe('Add Sentry integration');
    expect(generateIdeaText('Configure CI pipeline')).toBe('Configure CI pipeline');
    expect(generateIdeaText('Integrate Slack webhooks')).toBe('Integrate Slack webhooks');
  });

  it('prepends "Внедрить:" when no verb prefix found', () => {
    const result = generateIdeaText('Redis кэш ускоряет запросы');
    expect(result).toBe('Внедрить: Redis кэш ускоряет запросы');
  });

  it('strips [GUIDE] prefix before processing', () => {
    const result = generateIdeaText('[GUIDE] Подключить Playwright MCP');
    // After stripping [GUIDE], starts with "Подключить" which is not in verb list → prepend
    expect(result).toMatch(/^(Внедрить: )?Подключить Playwright MCP$/);
  });

  it('extracts only the first sentence', () => {
    const result = generateIdeaText('Факт о системе. Второе предложение. Третье.');
    expect(result).toBe('Внедрить: Факт о системе');
  });

  it('truncates to 200 chars max', () => {
    const longText = 'Добавить ' + 'x'.repeat(250);
    const result = generateIdeaText(longText);
    expect(result.length).toBeLessThanOrEqual(201); // 200 + '…'
  });
});

// ── 4. buildContextString — context assembly + 800 char limit ──────────────────

describe('buildContextString', () => {
  const emptyCtx: FullContext = { projects: [], domains: [], tasks: [], recentHashes: [] };

  it('returns empty string when all context arrays are empty', () => {
    expect(buildContextString(emptyCtx)).toBe('');
  });

  it('includes project name and focus', () => {
    const ctx: FullContext = {
      ...emptyCtx,
      projects: [{ name: 'MAOS', description: '', current_needs: null, tech_stack: null, current_focus: 'intake pipeline', long_term_goals: null }],
    };
    const result = buildContextString(ctx);
    expect(result).toContain('MAOS');
    expect(result).toContain('focus: intake pipeline');
  });

  it('includes project needs when present', () => {
    const ctx: FullContext = {
      ...emptyCtx,
      projects: [{ name: 'Runner', description: '', current_needs: 'cron scheduling', tech_stack: null, current_focus: null, long_term_goals: null }],
    };
    const result = buildContextString(ctx);
    expect(result).toContain('needs: cron scheduling');
  });

  it('sorts domains by priority descending', () => {
    const ctx: FullContext = {
      ...emptyCtx,
      domains: [
        { name: 'Low', description: '', priority: 1, examples: null },
        { name: 'High', description: '', priority: 10, examples: null },
        { name: 'Mid', description: '', priority: 5, examples: null },
      ],
    };
    const result = buildContextString(ctx);
    expect(result).toContain('Domains: High, Mid, Low');
  });

  it('limits tasks to 5', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({ title: `Task ${i}` }));
    const ctx: FullContext = { ...emptyCtx, tasks };
    const result = buildContextString(ctx);
    expect(result).toContain('Task 0');
    expect(result).toContain('Task 4');
    expect(result).not.toContain('Task 5');
  });

  it('truncates result to 800 chars max', () => {
    const longProjects = Array.from({ length: 20 }, (_, i) => ({
      name: `Project_${i}_${'x'.repeat(50)}`,
      description: '', current_needs: 'need', tech_stack: null,
      current_focus: 'focus_' + 'y'.repeat(30), long_term_goals: null,
    }));
    const ctx: FullContext = { ...emptyCtx, projects: longProjects };
    const result = buildContextString(ctx);
    expect(result.length).toBeLessThanOrEqual(MAX_CONTEXT);
  });
});

// ── 5. buildNotification — routed items → user-facing message ──────────────────

describe('buildNotification', () => {
  it('shows hot count when hot items exist', () => {
    const routed: RoutedKnowledgeItem[] = [
      { routed_to: 'hot_backlog' },
      { routed_to: 'hot_backlog' },
      { routed_to: 'knowledge_base' },
    ];
    expect(buildNotification(routed)).toBe('🔥 2 идей для текущих задач');
  });

  it('shows strategic count when no hot items', () => {
    const routed: RoutedKnowledgeItem[] = [
      { routed_to: 'knowledge_base' },
      { routed_to: 'knowledge_base' },
      { routed_to: 'discarded' },
    ];
    expect(buildNotification(routed)).toBe('📚 2 знаний сохранено в базу');
  });

  it('shows irrelevant message when all discarded', () => {
    const routed: RoutedKnowledgeItem[] = [
      { routed_to: 'discarded' },
      { routed_to: 'discarded' },
    ];
    expect(buildNotification(routed)).toBe('📭 Нерелевантен для наших направлений');
  });

  it('shows irrelevant message for empty array', () => {
    expect(buildNotification([])).toBe('📭 Нерелевантен для наших направлений');
  });

  it('prioritizes hot over strategic in message', () => {
    const routed: RoutedKnowledgeItem[] = [
      { routed_to: 'hot_backlog' },
      { routed_to: 'knowledge_base' },
      { routed_to: 'knowledge_base' },
      { routed_to: 'knowledge_base' },
    ];
    // hot > 0, so hot message takes priority even though strategic count is higher
    expect(buildNotification(routed)).toContain('🔥');
    expect(buildNotification(routed)).not.toContain('📚');
  });
});
