import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { analyzeWithChunking } from '../services/analyze';
import { saveExtractedKnowledge } from '../services/pitstop';
import { RoutedKnowledgeItem } from '../types';
import { ExtractionResult } from './types';

const RELEVANCE_GATE = 0.6;
const BATCH_SIZE = 5;
const README_MAX_CHARS = 12_000;
const GITHUB_API = 'https://api.github.com';

function getPitstopClient(): SupabaseClient {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP env not set');
  return createClient(url, key);
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  const h: Record<string, string> = { 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function fetchReadme(repoFullName: string): Promise<string | null> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/readme`, {
      headers: { ...githubHeaders(), Accept: 'application/vnd.github.v3.raw' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const text = await res.text();
    return text.slice(0, README_MAX_CHARS);
  } catch (err) {
    console.warn(`[extractor] README fetch failed for ${repoFullName}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function fetchSkillContent(commitUrl: string | null, repoUrl: string): Promise<string | null> {
  if (!commitUrl) return null;
  try {
    // commitUrl: https://api.github.com/repos/<owner>/<repo>/git/commits/<sha>
    // We want: https://raw.githubusercontent.com/<owner>/<repo>/main/SKILL.md
    const repoPath = repoUrl.replace('https://github.com/', '');
    const res = await fetch(
      `https://raw.githubusercontent.com/${repoPath}/main/SKILL.md`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, README_MAX_CHARS);
  } catch {
    return null;
  }
}

function routeItems(items: ReturnType<typeof filterByRelevance>): RoutedKnowledgeItem[] {
  return items.map((item) => ({
    ...item,
    routed_to:
      item.immediate_relevance >= 0.7
        ? 'hot_backlog'
        : item.strategic_relevance >= 0.5
          ? 'knowledge_base'
          : 'knowledge_base', // above gate threshold, keep all
  } as RoutedKnowledgeItem));
}

function filterByRelevance<T extends { immediate_relevance: number; strategic_relevance: number }>(items: T[]): T[] {
  return items.filter(
    (i) => i.immediate_relevance >= RELEVANCE_GATE || i.strategic_relevance >= RELEVANCE_GATE,
  );
}

export async function runExtraction(options?: { supabase?: SupabaseClient }): Promise<ExtractionResult> {
  const supabase = options?.supabase ?? getPitstopClient();
  let reposProcessed = 0;
  let skillsProcessed = 0;
  let knowledgeSaved = 0;
  const errors: string[] = [];

  // --- Process discovered_repos ---
  const { data: pendingRepos, error: reposErr } = await supabase
    .from('discovered_repos')
    .select('id, repo_full_name, source, language, description')
    .eq('processed', false)
    .order('stars_gained', { ascending: false, nullsFirst: false })
    .limit(BATCH_SIZE);

  if (reposErr) {
    console.error('[extractor] fetch pending repos error:', reposErr.message);
    errors.push(`repos fetch: ${reposErr.message}`);
  } else {
    for (const repo of pendingRepos ?? []) {
      const row = repo as { id: string; repo_full_name: string; source: string };
      const readme = await fetchReadme(row.repo_full_name);
      if (!readme) {
        await supabase.from('discovered_repos').update({ processed: true }).eq('id', row.id);
        reposProcessed++;
        continue;
      }

      const sourceLabel = `github:${row.source}:${row.repo_full_name}`;
      const text = `GitHub Repository: ${row.repo_full_name}\n\n${readme}`;

      try {
        const analysis = await analyzeWithChunking(text, sourceLabel);
        const relevant = filterByRelevance(analysis.knowledge_items);

        if (relevant.length > 0) {
          const routed = routeItems(relevant);
          const sourceType = row.source.startsWith('awesome:') ? 'awesome_addition'
            : row.source === 'trending' ? 'github_trending'
            : 'github_repo';
          const result = await saveExtractedKnowledge(
            routed,
            null,
            `https://github.com/${row.repo_full_name}`,
            sourceType,
          );
          knowledgeSaved += result.saved.length;
          console.log(`[extractor] ${row.repo_full_name}: saved=${result.saved.length} skipped=${result.dedupSkipped}`);
        } else {
          console.log(`[extractor] ${row.repo_full_name}: all items below gate (${analysis.knowledge_items.length} total)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[extractor] analysis failed for ${row.repo_full_name}:`, msg);
        errors.push(`${row.repo_full_name}: ${msg}`);
      }

      await supabase.from('discovered_repos').update({ processed: true }).eq('id', row.id);
      reposProcessed++;
    }
  }

  // --- Process discovered_skills ---
  const { data: pendingSkills, error: skillsErr } = await supabase
    .from('discovered_skills')
    .select('id, repo_url, commit_url, skill_content, source')
    .eq('processed', false)
    .limit(BATCH_SIZE);

  if (skillsErr) {
    console.error('[extractor] fetch pending skills error:', skillsErr.message);
    errors.push(`skills fetch: ${skillsErr.message}`);
  } else {
    for (const skill of pendingSkills ?? []) {
      const row = skill as { id: string; repo_url: string; commit_url: string | null; skill_content: string | null; source: string };
      const content = row.skill_content ?? await fetchSkillContent(row.commit_url, row.repo_url);
      if (!content) {
        await supabase.from('discovered_skills').update({ processed: true }).eq('id', row.id);
        skillsProcessed++;
        continue;
      }

      const sourceLabel = `github:skill:${row.repo_url}`;
      const text = `SKILL.md from ${row.repo_url}:\n\n${content}`;

      try {
        const analysis = await analyzeWithChunking(text, sourceLabel);
        const relevant = filterByRelevance(analysis.knowledge_items);

        if (relevant.length > 0) {
          const routed = routeItems(relevant);
          const result = await saveExtractedKnowledge(
            routed,
            null,
            row.repo_url,
            'new_skill',
          );
          knowledgeSaved += result.saved.length;
          console.log(`[extractor] skill ${row.repo_url}: saved=${result.saved.length}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[extractor] skill analysis failed for ${row.repo_url}:`, msg);
        errors.push(`skill:${row.repo_url}: ${msg}`);
      }

      await supabase.from('discovered_skills').update({ processed: true }).eq('id', row.id);
      skillsProcessed++;
    }
  }

  const status = errors.length === 0 ? 'ok' : errors.length < reposProcessed + skillsProcessed ? 'partial' : 'error';
  console.log(`[extractor] Done. repos=${reposProcessed} skills=${skillsProcessed} knowledge=${knowledgeSaved}`);
  return {
    status: (status === 'partial' ? 'ok' : status) as 'ok' | 'skipped' | 'error',
    repos_processed: reposProcessed,
    skills_processed: skillsProcessed,
    knowledge_saved: knowledgeSaved,
    errors,
  };
}
