/**
 * GitHub Parsing Pipeline — Cluster 6, Phase 2.
 *
 * Three discovery sources → discovered_repos / discovered_skills → Haiku extraction → extracted_knowledge
 *   1. GitHub Trending Daily (Apify junipr/github-trending-scraper) — cron 09:00 UTC
 *   2. Awesome-list Atom feed diff monitor — cron every 6 hours
 *   3. BigQuery GH Archive SKILL.md discovery — cron 10:00 UTC
 *   4. Haiku extraction of pending repos/skills — cron hourly
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { runTrendingFetch } from './trending';
import { runAwesomeListsFetch } from './awesome-lists';
import { runBigQuerySkillsFetch } from './bigquery-skills';
import { runExtraction } from './extractor';
import { TrendingResult, AwesomeListResult, BigQuerySkillsResult, ExtractionResult } from './types';

export { runTrendingFetch, runAwesomeListsFetch, runBigQuerySkillsFetch, runExtraction };
export type { TrendingResult, AwesomeListResult, BigQuerySkillsResult, ExtractionResult };

function getPitstopClient(): SupabaseClient {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP env not set');
  return createClient(url, key);
}

async function writeIntakeLog(
  supabase: SupabaseClient,
  pipeline: string,
  result: Record<string, unknown>,
): Promise<void> {
  await supabase.from('context_snapshots').insert({
    snapshot_type: 'intake_processing_log',
    content: {
      type: 'intake_processing_log',
      pipeline: `github_parsing:${pipeline}`,
      ...result,
      date: new Date().toISOString(),
    },
  });
}

export async function handleTrendingRun(supabase?: SupabaseClient): Promise<TrendingResult> {
  const sb = supabase ?? getPitstopClient();
  const result = await runTrendingFetch({ supabase: sb });
  await writeIntakeLog(sb, 'trending', {
    status: result.status,
    discovered: result.discovered,
    skipped: result.skipped,
    errors: result.errors,
  });
  return result;
}

export async function handleAwesomeListsRun(supabase?: SupabaseClient): Promise<AwesomeListResult> {
  const sb = supabase ?? getPitstopClient();
  const result = await runAwesomeListsFetch({ supabase: sb });
  await writeIntakeLog(sb, 'awesome_lists', {
    status: result.status,
    feeds_checked: result.feeds_checked,
    new_commits: result.new_commits,
    repos_discovered: result.repos_discovered,
    errors: result.errors,
  });
  return result;
}

export async function handleBigQuerySkillsRun(supabase?: SupabaseClient): Promise<BigQuerySkillsResult> {
  const sb = supabase ?? getPitstopClient();
  const result = await runBigQuerySkillsFetch({ supabase: sb });
  await writeIntakeLog(sb, 'bigquery_skills', {
    status: result.status,
    rows_scanned: result.rows_scanned,
    skills_discovered: result.skills_discovered,
    error: result.error,
  });
  return result;
}

export async function handleExtractionRun(supabase?: SupabaseClient): Promise<ExtractionResult> {
  const sb = supabase ?? getPitstopClient();
  const result = await runExtraction({ supabase: sb });
  await writeIntakeLog(sb, 'extraction', {
    status: result.status,
    repos_processed: result.repos_processed,
    skills_processed: result.skills_processed,
    knowledge_saved: result.knowledge_saved,
    errors: result.errors,
  });
  return result;
}
