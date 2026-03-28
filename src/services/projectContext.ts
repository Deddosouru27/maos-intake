import { createClient } from '@supabase/supabase-js';

interface ProjectContext {
  name: string;
  description: string;
  relevant_topics: string[] | null;
}

let cachedProjects: ProjectContext[] = [];
let lastFetchedAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getProjectContext(): Promise<ProjectContext[]> {
  const now = Date.now();
  if (cachedProjects.length > 0 && now - lastFetchedAt < CACHE_TTL) {
    return cachedProjects;
  }

  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.warn('[projectContext] PITSTOP env vars not set, skipping project fetch');
    return cachedProjects;
  }

  try {
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from('projects')
      .select('name, description, relevant_topics')
      .not('description', 'is', null);

    if (error) throw error;
    cachedProjects = (data as ProjectContext[]) || [];
    lastFetchedAt = now;
    console.log(`[projectContext] loaded ${cachedProjects.length} projects`);
    return cachedProjects;
  } catch (err) {
    console.error('[projectContext] fetch failed:', err);
    return cachedProjects; // stale cache on error
  }
}

export function buildProjectContextPrompt(projects: ProjectContext[]): string {
  if (projects.length === 0) {
    return 'Проектов нет в базе. Извлекай общие технологические идеи.';
  }

  return projects.map((p, i) => {
    const topics = p.relevant_topics?.length
      ? `\n   Релевантные темы: ${p.relevant_topics.join(', ')}`
      : '';
    return `${i + 1}. ${p.name} — ${p.description}${topics}`;
  }).join('\n\n');
}
