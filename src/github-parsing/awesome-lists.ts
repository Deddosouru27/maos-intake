import { XMLParser } from 'fast-xml-parser';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AwesomeListResult } from './types';

const FEEDS: { name: string; url: string; owner: string; repo: string }[] = [
  {
    name: 'awesome-mcp-servers',
    url: 'https://github.com/punkpeye/awesome-mcp-servers/commits/main.atom',
    owner: 'punkpeye',
    repo: 'awesome-mcp-servers',
  },
  {
    name: 'awesome-claude-code',
    url: 'https://github.com/erkcet/awesome-claude-code/commits/main.atom',
    owner: 'erkcet',
    repo: 'awesome-claude-code',
  },
  {
    name: 'awesome-agent-skills',
    url: 'https://github.com/VoltAgent/awesome-agent-skills/commits/main.atom',
    owner: 'VoltAgent',
    repo: 'awesome-agent-skills',
  },
  {
    name: 'awesome-ai-agents',
    url: 'https://github.com/e2b-dev/awesome-ai-agents/commits/main.atom',
    owner: 'e2b-dev',
    repo: 'awesome-ai-agents',
  },
];

// Matches GitHub markdown links: [title](https://github.com/owner/repo...)
const GITHUB_LINK_RE = /\[([^\]]+)\]\((https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)[^)]*\)/g;

function getPitstopClient(): SupabaseClient {
  const url = process.env.PITSTOP_SUPABASE_URL;
  const key = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('PITSTOP env not set');
  return createClient(url, key);
}

async function fetchAtomFeed(feedUrl: string): Promise<{ sha: string; updated: string }[]> {
  const res = await fetch(feedUrl, {
    headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Feed fetch ${res.status}: ${feedUrl}`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const feed = parsed['feed'] as Record<string, unknown> | undefined;
  if (!feed) return [];

  const entries = feed['entry'];
  if (!entries) return [];
  const list = Array.isArray(entries) ? entries : [entries];

  return list
    .map((e: unknown) => {
      const entry = e as Record<string, unknown>;
      const id = String(entry['id'] ?? '');
      // Atom id format: tag:github.com,2008:Grit::Commit/<sha>
      const sha = id.split('/').pop() ?? '';
      const updated = String(entry['updated'] ?? '');
      return { sha, updated };
    })
    .filter((x) => x.sha.length >= 7);
}

async function getNewCommitShas(
  supabase: SupabaseClient,
  shas: string[],
): Promise<string[]> {
  if (shas.length === 0) return [];
  const { data } = await supabase
    .from('processed_commits')
    .select('sha')
    .in('sha', shas);
  const seen = new Set((data ?? []).map((r: { sha: string }) => r.sha));
  return shas.filter((s) => !seen.has(s));
}

async function fetchCommitDiff(
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.diff',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return '';
  return res.text();
}

function extractGitHubRepos(diff: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = GITHUB_LINK_RE.exec(diff)) !== null) {
    found.add(match[2]);
  }
  return [...found];
}

export async function runAwesomeListsFetch(options?: { supabase?: SupabaseClient }): Promise<AwesomeListResult> {
  const supabase = options?.supabase ?? getPitstopClient();
  const parser = new XMLParser();
  void parser; // used via fetchAtomFeed

  let feedsChecked = 0;
  let newCommits = 0;
  let reposDiscovered = 0;
  const errors: string[] = [];

  const feedResults = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const entries = await fetchAtomFeed(feed.url);
      const shas = entries.map((e) => e.sha);
      const newShas = await getNewCommitShas(supabase, shas);
      console.log(`[awesome-lists] ${feed.name}: ${shas.length} commits, ${newShas.length} new`);

      let feedRepos = 0;
      for (const sha of newShas) {
        const diff = await fetchCommitDiff(feed.owner, feed.repo, sha);
        const repos = extractGitHubRepos(diff);

        for (const repoUrl of repos) {
          const repoFullName = repoUrl.replace('https://github.com/', '');
          const { error } = await supabase.from('discovered_repos').insert({
            repo_full_name: repoFullName,
            language: null,
            source: `awesome:${feed.name}`,
            description: null,
          });
          if (!error || error.code === '23505') feedRepos++;
        }

        await supabase.from('processed_commits').insert({
          sha,
          repo_full_name: `${feed.owner}/${feed.repo}`,
          list_name: feed.name,
        }).throwOnError();

        newCommits++;
      }

      feedsChecked++;
      reposDiscovered += feedRepos;
      return feedRepos;
    }),
  );

  for (const r of feedResults) {
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      errors.push(msg);
      console.error('[awesome-lists] feed error:', msg);
    }
  }

  const status = errors.length === 0 ? 'ok' : reposDiscovered > 0 ? 'partial' : 'error';
  console.log(`[awesome-lists] Done. feeds=${feedsChecked} new_commits=${newCommits} repos=${reposDiscovered}`);
  return { status, feeds_checked: feedsChecked, new_commits: newCommits, repos_discovered: reposDiscovered, errors };
}
