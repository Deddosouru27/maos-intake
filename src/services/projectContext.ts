import { createClient } from '@supabase/supabase-js';

export interface ProjectContext {
  name: string;
  description: string;
  current_needs: string | null;
  tech_stack: string[] | null;
  current_focus: string | null;
  long_term_goals: string | null;
}

export interface DomainContext {
  name: string;
  description: string;
  priority: number;
  examples: string[] | null;
}

export interface TaskContext {
  title: string;
}

export interface FullContext {
  projects: ProjectContext[];
  domains: DomainContext[];
  tasks: TaskContext[];
  recentHashes: string[];
}

let cachedContext: FullContext | null = null;
let lastFetchedAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function getFullContext(): Promise<FullContext> {
  const now = Date.now();
  if (cachedContext && now - lastFetchedAt < CACHE_TTL) {
    return cachedContext;
  }

  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.warn('[projectContext] PITSTOP env vars not set, using empty context');
    return cachedContext ?? { projects: [], domains: [], tasks: [], recentHashes: [] };
  }

  const supabase = createClient(url, key);

  const [projectsResult, domainsResult, tasksResult, hashesResult] = await Promise.allSettled([
    supabase
      .from('projects')
      .select('name, description, current_needs, tech_stack, current_focus, long_term_goals')
      .not('description', 'is', null),
    supabase
      .from('knowledge_domains')
      .select('name, description, priority, examples')
      .eq('is_active', true),
    supabase
      .from('tasks')
      .select('title')
      .not('status', 'in', '("done","cancelled")')
      .limit(10),
    supabase
      .from('ingested_content')
      .select('content_hash')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const projects =
    projectsResult.status === 'fulfilled' && !projectsResult.value.error
      ? ((projectsResult.value.data as ProjectContext[]) ?? [])
      : [];
  const domains =
    domainsResult.status === 'fulfilled' && !domainsResult.value.error
      ? ((domainsResult.value.data as DomainContext[]) ?? [])
      : [];
  const tasks =
    tasksResult.status === 'fulfilled' && !tasksResult.value.error
      ? ((tasksResult.value.data as TaskContext[]) ?? [])
      : [];
  const recentHashes =
    hashesResult.status === 'fulfilled' && !hashesResult.value.error
      ? ((hashesResult.value.data as { content_hash: string }[]) ?? []).map(
          (r) => r.content_hash,
        )
      : [];

  cachedContext = { projects, domains, tasks, recentHashes };
  lastFetchedAt = now;
  console.log(
    `[projectContext] loaded ${projects.length} projects, ${domains.length} domains, ${tasks.length} tasks, ${recentHashes.length} hashes`,
  );
  return cachedContext;
}

export function buildSystemPrompt(context: FullContext): string {
  const MAX_PROJECTS_CHARS = 1000;
  const MAX_DOMAINS_CHARS = 700;
  const MAX_TASKS_CHARS = 300;

  let projectsSection =
    context.projects.length === 0
      ? 'Проектов нет в базе.'
      : context.projects
          .map((p, i) => {
            const lines = [`${i + 1}. **${p.name}** — ${p.description}`];
            if (p.current_focus) lines.push(`   Текущий фокус: ${p.current_focus}`);
            if (p.current_needs) lines.push(`   Текущие потребности: ${p.current_needs}`);
            if (p.long_term_goals) lines.push(`   Долгосрочные цели: ${p.long_term_goals}`);
            if (p.tech_stack?.length) lines.push(`   Стек: ${p.tech_stack.join(', ')}`);
            return lines.join('\n');
          })
          .join('\n\n');
  if (projectsSection.length > MAX_PROJECTS_CHARS) {
    projectsSection = projectsSection.slice(0, MAX_PROJECTS_CHARS) + '...[обрезано]';
  }

  let domainsSection =
    context.domains.length === 0
      ? 'Областей интересов нет в базе.'
      : [...context.domains]
          .sort((a, b) => b.priority - a.priority)
          .map((d, i) => {
            const examples = d.examples?.length
              ? ` Примеры: ${d.examples.join(', ')}.`
              : '';
            return `${i + 1}. **${d.name}** (приоритет ${d.priority}) — ${d.description}.${examples}`;
          })
          .join('\n');
  if (domainsSection.length > MAX_DOMAINS_CHARS) {
    domainsSection = domainsSection.slice(0, MAX_DOMAINS_CHARS) + '...[обрезано]';
  }

  let tasksSection =
    context.tasks.length === 0
      ? 'Активных задач нет.'
      : context.tasks.map((t) => `• ${t.title}`).join('\n');
  if (tasksSection.length > MAX_TASKS_CHARS) {
    tasksSection = tasksSection.slice(0, MAX_TASKS_CHARS) + '...[обрезано]';
  }

  return `Ты — инженерный аналитик и исследователь для системы MAOS. Ты выполняешь ДВЕ роли одновременно:

РОЛЬ 1 — ИНЖЕНЕР: ищешь конкретные решения для текущих проблем проектов.
РОЛЬ 2 — ИССЛЕДОВАТЕЛЬ: накапливаешь ценные знания для широких тематических направлений, даже если они не нужны прямо сейчас.

## Наши проекты (из базы данных)

${projectsSection}

## Широкие области интересов (из базы данных)

${domainsSection}

Мы копим знания по ВСЕМ этим направлениям. Даже если сейчас нет активного проекта по теме — знание ценно если оно в рамках наших domains.

## Над чем работаем сейчас

${tasksSection}

## Как анализировать

ШАГ 1. Прочитай контент. Определи основную тему.

ШАГ 2. IMMEDIATE RELEVANCE — спроси: "Решает ли это конкретную текущую проблему из current_needs?" Если да — immediate_relevance высокий + solves_need заполнен.

ШАГ 3. STRATEGIC RELEVANCE — спроси: "Попадает ли это в наши knowledge_domains?" Контент про AI агентов при отсутствии прямой задачи — всё равно strategic 0.7+ если domain "AI агенты" active. Контент про кулинарию — strategic 0.0.

ШАГ 4. NOVELTY — спроси: "Это новое знание или мы уже это знаем/обсуждали?" Если статья повторяет банальности ("AI это будущее") — novelty 0.1. Если описывает конкретный новый паттерн/инструмент — novelty 0.8+.

ШАГ 5. Для каждой единицы знания определи knowledge_type:
- actionable_idea: конкретное действие ("добавить retry в Runner")
- tool_or_library: готовый инструмент ("LangGraph для оркестрации агентов")
- architecture_pattern: паттерн ("circuit breaker для API вызовов")
- code_snippet: готовый код
- insight: ценное наблюдение
- technique: методика
- case_study: кейс реализации
- strategic_idea: идея для будущего проекта
- lesson_learned: урок из чужого опыта

## Правила

1. ВСЕ на русском языке.
2. Извлекай 7-10 ключевых инсайтов, идей и уроков из контента. ИГНОРИРУЙ: рекламные вставки, спонсорские блоки, партнёрские предложения, промо-плагины и офтопик. Извлекай только знания по основной теме контента. Каждый инсайт должен быть напрямую применим или стратегически важен для построения AI-систем, автоматизации или оптимизации бизнеса.
3. НЕ ВЫДУМЫВАЙ знания которых нет в контенте.
4. Контент может быть: нерелевантен сейчас НО стратегически ценен. Это НЕ причина выбрасывать.
5. Контент вне ВСЕХ knowledge_domains (кулинария, спорт, личная жизнь) → immediate 0.0, strategic 0.0.
6. Если в контенте есть ГОТОВЫЙ КОД — обязательно has_ready_code: true.
7. priority_signal: true ТОЛЬКО если: критический баг в нашем стеке, готовый open-source заменяющий наш самопис, существенное удешевление наших сервисов.`;
}
