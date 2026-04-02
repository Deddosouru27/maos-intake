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
      .eq('processing_status', 'done')
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

const MAX_CONTEXT = 800;

export function buildContextString(context: FullContext): string {
  const parts: string[] = [];

  if (context.projects.length > 0) {
    const projects = context.projects
      .map((p) => {
        const bits = [p.name];
        if (p.current_focus) bits.push(`focus: ${p.current_focus}`);
        if (p.current_needs) bits.push(`needs: ${p.current_needs}`);
        return bits.join(' — ');
      })
      .join('; ');
    parts.push(`Projects: ${projects}`);
  }

  if (context.domains.length > 0) {
    const domains = [...context.domains]
      .sort((a, b) => b.priority - a.priority)
      .map((d) => d.name)
      .join(', ');
    parts.push(`Domains: ${domains}`);
  }

  if (context.tasks.length > 0) {
    const tasks = context.tasks
      .slice(0, 5)
      .map((t) => t.title)
      .join('; ');
    parts.push(`Active tasks: ${tasks}`);
  }

  const result = parts.join('\n');
  return result.length > MAX_CONTEXT ? result.substring(0, MAX_CONTEXT) : result;
}
