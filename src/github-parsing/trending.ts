import { ApifyClient } from 'apify-client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TrendingResult } from './types';

const ACTOR_ID = 'junipr/github-trending-scraper';
const LANGUAGES = ['typescript', 'python', 'rust', 'go'];

function getPitstopClient(): SupabaseClient {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP env not set');
  return createClient(url, key);
}

export async function runTrendingFetch(options?: { supabase?: SupabaseClient }): Promise<TrendingResult> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return { status: 'error', discovered: 0, skipped: 0, errors: ['APIFY_TOKEN not set'] };
  }

  const supabase = options?.supabase ?? getPitstopClient();
  const apify = new ApifyClient({ token });

  let totalDiscovered = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (const language of LANGUAGES) {
    try {
      console.log(`[trending] Running actor for language: ${language}`);
      const run = await apify.actor(ACTOR_ID).call(
        { languages: [language], date_range: 'daily' },
        { waitSecs: 120 },
      );

      const { items } = await apify.dataset(run.defaultDatasetId).listItems();
      console.log(`[trending] ${language}: ${items.length} repos from actor`);

      for (const item of items) {
        const repoName = (item['full_name'] as string) ?? null;
        if (!repoName) continue;

        const { error } = await supabase.from('discovered_repos').insert({
          repo_full_name: repoName,
          language: (item['primary_language'] as string) ?? language,
          stars_total: (item['stars_total'] as number) ?? null,
          stars_gained: (item['stars_gained_today'] as number) ?? null,
          description: (item['description'] as string) ?? null,
          source: 'trending',
        });

        if (error) {
          if (error.code === '23505') {
            totalSkipped++;
          } else {
            console.warn(`[trending] insert error for ${repoName}:`, error.message);
            errors.push(`${repoName}: ${error.message}`);
          }
        } else {
          totalDiscovered++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[trending] language ${language} failed:`, msg);
      errors.push(`${language}: ${msg}`);
    }
  }

  const status = errors.length === 0 ? 'ok' : totalDiscovered > 0 ? 'partial' : 'error';
  console.log(`[trending] Done. discovered=${totalDiscovered} skipped=${totalSkipped} errors=${errors.length}`);
  return { status, discovered: totalDiscovered, skipped: totalSkipped, errors };
}
