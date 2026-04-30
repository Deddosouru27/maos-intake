import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BigQuerySkillsResult } from './types';

function getPitstopClient(): SupabaseClient {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP env not set');
  return createClient(url, key);
}

function yesterdayPartition(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

interface BigQueryRow {
  commit_url: string;
  repo_url: string;
}

async function getBigQueryClient() {
  // On Vercel: use GOOGLE_CREDENTIALS_JSON (full JSON string)
  // Locally: use GOOGLE_APPLICATION_CREDENTIALS (file path, handled automatically)
  const { BigQuery } = await import('@google-cloud/bigquery');

  const credJson = process.env.GOOGLE_CREDENTIALS_JSON;
  if (credJson) {
    const credentials = JSON.parse(credJson) as Record<string, unknown>;
    return new BigQuery({ credentials, projectId: credentials['project_id'] as string });
  }

  // Falls back to GOOGLE_APPLICATION_CREDENTIALS file path (local dev)
  return new BigQuery();
}

export async function runBigQuerySkillsFetch(options?: { supabase?: SupabaseClient }): Promise<BigQuerySkillsResult> {
  const credJson = process.env.GOOGLE_CREDENTIALS_JSON;
  const credFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credJson && !credFile) {
    return { status: 'error', rows_scanned: 0, skills_discovered: 0, error: 'No GCP credentials configured' };
  }

  const supabase = options?.supabase ?? getPitstopClient();
  const partition = yesterdayPartition();

  const query = `
    SELECT
      JSON_EXTRACT_SCALAR(payload, "$.commits[0].url") AS commit_url,
      repo.url AS repo_url
    FROM \`githubarchive.day.${partition}\`
    WHERE type = 'PushEvent'
      AND JSON_EXTRACT(payload, "$.commits[0].message") IS NOT NULL
      AND (
        CAST(JSON_EXTRACT(payload, "$.commits[0].added") AS STRING) LIKE '%SKILL.md%'
        OR CAST(JSON_EXTRACT(payload, "$.commits[0].modified") AS STRING) LIKE '%SKILL.md%'
      )
    LIMIT 100
  `;

  let bq;
  try {
    bq = await getBigQueryClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', rows_scanned: 0, skills_discovered: 0, error: `BigQuery client init: ${msg}` };
  }

  let rows: BigQueryRow[];
  try {
    console.log(`[bigquery-skills] Querying partition ${partition}`);
    const [job] = await bq.createQueryJob({ query, location: 'US' });
    const [result] = await job.getQueryResults();
    rows = result as BigQueryRow[];
    console.log(`[bigquery-skills] Got ${rows.length} rows`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[bigquery-skills] Query failed:', msg);
    return { status: 'error', rows_scanned: 0, skills_discovered: 0, error: msg };
  }

  let skillsDiscovered = 0;
  for (const row of rows) {
    if (!row.repo_url) continue;
    const { error } = await supabase.from('discovered_skills').insert({
      repo_url: row.repo_url,
      commit_url: row.commit_url ?? null,
      source: 'bigquery',
    });
    if (error && error.code !== '23505') {
      console.warn('[bigquery-skills] insert error:', error.message);
    } else if (!error) {
      skillsDiscovered++;
    }
  }

  console.log(`[bigquery-skills] Done. partition=${partition} scanned=${rows.length} saved=${skillsDiscovered}`);
  return { status: 'ok', rows_scanned: rows.length, skills_discovered: skillsDiscovered };
}
