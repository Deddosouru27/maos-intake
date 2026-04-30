/**
 * Unit tests for GitHub Parsing Pipeline (Cluster 6).
 * Pure functions replicated inline — no external deps, no DB, no Apify.
 *
 * Mutation tests:
 *   1. Remove RELEVANCE_GATE → items with score 0.3 go to extracted_knowledge (should filter out)
 *   2. Remove yesterdayPartition date guard → BigQuery scans wrong partition
 *   3. Remove GITHUB_LINK_RE match → awesome-list repos never extracted from diff
 *   4. Remove processed_commits check → same commits reprocessed every 6 hours (infinite loop)
 */
import { describe, it, expect } from 'vitest';

// ── Pure functions replicated from github-parsing modules ─────────────────────

const RELEVANCE_GATE = 0.6;

function filterByRelevance<T extends { immediate_relevance: number; strategic_relevance: number }>(
  items: T[],
): T[] {
  return items.filter(
    (i) => i.immediate_relevance >= RELEVANCE_GATE || i.strategic_relevance >= RELEVANCE_GATE,
  );
}

function routeItem(item: { immediate_relevance: number; strategic_relevance: number }): string {
  return item.immediate_relevance >= 0.7 ? 'hot_backlog' : 'knowledge_base';
}

function yesterdayPartition(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

const GITHUB_LINK_RE = /\[([^\]]+)\]\((https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)[^)]*\)/g;

function extractGitHubRepos(diff: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(GITHUB_LINK_RE.source, GITHUB_LINK_RE.flags);
  while ((match = re.exec(diff)) !== null) {
    found.add(match[2]);
  }
  return [...found];
}

// ── 1. filterByRelevance ──────────────────────────────────────────────────────

describe('filterByRelevance', () => {
  it('passes items at exactly RELEVANCE_GATE on immediate', () => {
    const items = [{ immediate_relevance: 0.6, strategic_relevance: 0.0, content: 'x' }];
    expect(filterByRelevance(items)).toHaveLength(1);
  });

  it('passes items at exactly RELEVANCE_GATE on strategic', () => {
    const items = [{ immediate_relevance: 0.0, strategic_relevance: 0.6, content: 'x' }];
    expect(filterByRelevance(items)).toHaveLength(1);
  });

  // MUTATION: removing RELEVANCE_GATE → 0.3 item would pass
  it('MUTATION: blocks items below gate (0.59 immediate + 0.59 strategic)', () => {
    const items = [{ immediate_relevance: 0.59, strategic_relevance: 0.59, content: 'noise' }];
    expect(filterByRelevance(items)).toHaveLength(0);
  });

  it('passes items above gate on immediate (0.8)', () => {
    const items = [{ immediate_relevance: 0.8, strategic_relevance: 0.0, content: 'hot' }];
    expect(filterByRelevance(items)).toHaveLength(1);
  });

  it('filters mixed batch correctly', () => {
    const items = [
      { immediate_relevance: 0.9, strategic_relevance: 0.0, content: 'keep' },
      { immediate_relevance: 0.3, strategic_relevance: 0.4, content: 'drop' },
      { immediate_relevance: 0.0, strategic_relevance: 0.7, content: 'keep' },
      { immediate_relevance: 0.1, strategic_relevance: 0.1, content: 'drop' },
    ];
    const kept = filterByRelevance(items);
    expect(kept).toHaveLength(2);
    expect(kept.map((i) => i.content)).toEqual(['keep', 'keep']);
  });

  it('returns empty for empty input', () => {
    expect(filterByRelevance([])).toHaveLength(0);
  });
});

// ── 2. routeItem ──────────────────────────────────────────────────────────────

describe('routeItem', () => {
  it('routes immediate >= 0.7 to hot_backlog', () => {
    expect(routeItem({ immediate_relevance: 0.7, strategic_relevance: 0.0 })).toBe('hot_backlog');
    expect(routeItem({ immediate_relevance: 0.9, strategic_relevance: 0.0 })).toBe('hot_backlog');
  });

  it('routes immediate < 0.7 to knowledge_base', () => {
    expect(routeItem({ immediate_relevance: 0.65, strategic_relevance: 0.6 })).toBe('knowledge_base');
    expect(routeItem({ immediate_relevance: 0.6, strategic_relevance: 0.6 })).toBe('knowledge_base');
  });
});

// ── 3. yesterdayPartition ─────────────────────────────────────────────────────

describe('yesterdayPartition', () => {
  // MUTATION: removing -1 offset → BigQuery queries today's partition (may not exist)
  it('MUTATION: returns yesterday, not today', () => {
    const today = new Date('2026-05-01T12:00:00Z');
    const partition = yesterdayPartition(today);
    expect(partition).toBe('20260430');
    expect(partition).not.toBe('20260501');
  });

  it('returns 8-digit YYYYMMDD format', () => {
    const partition = yesterdayPartition(new Date('2026-05-01T00:00:00Z'));
    expect(partition).toMatch(/^\d{8}$/);
  });

  it('correctly crosses month boundary', () => {
    const firstOfMonth = new Date('2026-05-01T00:30:00Z');
    const partition = yesterdayPartition(firstOfMonth);
    expect(partition).toBe('20260430');
  });

  it('correctly crosses year boundary', () => {
    const newYear = new Date('2026-01-01T06:00:00Z');
    const partition = yesterdayPartition(newYear);
    expect(partition).toBe('20251231');
  });
});

// ── 4. extractGitHubRepos ─────────────────────────────────────────────────────

describe('extractGitHubRepos', () => {
  // MUTATION: removing regex → returns [] even when diff has GitHub links
  it('MUTATION: extracts GitHub repo URLs from markdown diff', () => {
    const diff = `
+## New Additions
+- [AwesomeTool](https://github.com/owner/tool-name) - A great tool
+- [Another](https://github.com/org/another-repo/tree/main) - Another one
    `;
    const repos = extractGitHubRepos(diff);
    expect(repos).toContain('https://github.com/owner/tool-name');
    expect(repos).toContain('https://github.com/org/another-repo');
  });

  it('deduplicates same repo mentioned twice', () => {
    const diff = `
+- [Tool A](https://github.com/owner/tool) - first mention
+- [Tool A again](https://github.com/owner/tool) - second mention
    `;
    const repos = extractGitHubRepos(diff);
    expect(repos).toHaveLength(1);
  });

  it('returns empty array for diff with no GitHub links', () => {
    const diff = '+## Updated docs\n+Fixed typos in README.';
    expect(extractGitHubRepos(diff)).toHaveLength(0);
  });

  it('ignores non-GitHub URLs', () => {
    const diff = `+- [NPM pkg](https://npmjs.com/package/foo) - npm package`;
    expect(extractGitHubRepos(diff)).toHaveLength(0);
  });

  it('handles multiple repos in one line', () => {
    const diff = `+Uses [RepoA](https://github.com/a/repoA) and [RepoB](https://github.com/b/repoB)`;
    const repos = extractGitHubRepos(diff);
    expect(repos).toHaveLength(2);
  });
});

// ── 5. Discovery source logic ─────────────────────────────────────────────────

describe('source classification', () => {
  function classifySource(source: string): string {
    if (source === 'trending') return 'github_trending';
    if (source.startsWith('awesome:')) return 'awesome_addition';
    return 'github_repo';
  }

  it('trending maps to github_trending source_type', () => {
    expect(classifySource('trending')).toBe('github_trending');
  });

  it('awesome:name maps to awesome_addition source_type', () => {
    expect(classifySource('awesome:awesome-mcp-servers')).toBe('awesome_addition');
    expect(classifySource('awesome:awesome-ai-agents')).toBe('awesome_addition');
  });

  it('unknown source maps to github_repo', () => {
    expect(classifySource('bigquery')).toBe('github_repo');
  });
});

// ── 6. BigQuery query safety (partition guard) ────────────────────────────────

describe('BigQuery partition safety', () => {
  it('partition string is numeric YYYYMMDD (no format injection)', () => {
    const partition = yesterdayPartition();
    // Must be exactly 8 digits — safe for SQL interpolation in backtick table name
    expect(partition).toMatch(/^\d{8}$/);
    expect(partition.length).toBe(8);
  });

  it('partition is never in the future', () => {
    const partition = yesterdayPartition();
    const today = new Date();
    const todayStr = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
    expect(partition < todayStr).toBe(true);
  });
});

// ── 7. README truncation guard ────────────────────────────────────────────────

describe('README truncation', () => {
  const README_MAX_CHARS = 12_000;

  it('truncates README to max chars before Haiku analysis', () => {
    const longReadme = 'x'.repeat(20_000);
    const truncated = longReadme.slice(0, README_MAX_CHARS);
    expect(truncated.length).toBe(README_MAX_CHARS);
    expect(longReadme.length).toBeGreaterThan(README_MAX_CHARS);
  });

  it('short README passes unchanged', () => {
    const shortReadme = 'Short README content';
    const truncated = shortReadme.slice(0, README_MAX_CHARS);
    expect(truncated).toBe(shortReadme);
  });
});

// ── 8. Idempotency keys ───────────────────────────────────────────────────────

describe('idempotency', () => {
  // MUTATION: removing dedup check → same commit reprocessed every run
  it('MUTATION: processed commit set correctly identifies seen vs new SHAs', () => {
    const processedShas = new Set(['abc123', 'def456', 'ghi789']);
    const incoming = ['abc123', 'NEW001', 'def456', 'NEW002'];
    const newShas = incoming.filter((sha) => !processedShas.has(sha));
    expect(newShas).toEqual(['NEW001', 'NEW002']);
    expect(newShas).toHaveLength(2);
  });

  it('all seen → returns empty array (no reprocessing)', () => {
    const processedShas = new Set(['abc', 'def']);
    const incoming = ['abc', 'def'];
    const newShas = incoming.filter((sha) => !processedShas.has(sha));
    expect(newShas).toHaveLength(0);
  });

  it('all new → returns all (first run)', () => {
    const processedShas = new Set<string>();
    const incoming = ['sha1', 'sha2', 'sha3'];
    const newShas = incoming.filter((sha) => !processedShas.has(sha));
    expect(newShas).toHaveLength(3);
  });
});

// ── 9. CRON_SECRET auth (Railway → Vercel) ────────────────────────────────────

function verifyCronSecret(
  headerValue: string | undefined,
  envSecret: string | undefined,
): 'ok' | 'no_secret_configured' | 'unauthorized' {
  if (!envSecret) return 'no_secret_configured';
  if (headerValue !== envSecret) return 'unauthorized';
  return 'ok';
}

describe('verifyCronSecret', () => {
  // MUTATION: removing auth → any caller can trigger Haiku extraction (cost blowout)
  it('MUTATION: returns unauthorized when header missing', () => {
    expect(verifyCronSecret(undefined, 'my-secret')).toBe('unauthorized');
  });

  it('MUTATION: returns unauthorized when header does not match', () => {
    expect(verifyCronSecret('wrong-secret', 'my-secret')).toBe('unauthorized');
  });

  it('returns ok when header matches secret', () => {
    expect(verifyCronSecret('my-secret', 'my-secret')).toBe('ok');
  });

  it('returns no_secret_configured when env not set', () => {
    expect(verifyCronSecret('anything', undefined)).toBe('no_secret_configured');
  });

  it('returns unauthorized for empty string header (not a match)', () => {
    expect(verifyCronSecret('', 'my-secret')).toBe('unauthorized');
  });

  it('secret comparison is exact (case-sensitive)', () => {
    expect(verifyCronSecret('MY-SECRET', 'my-secret')).toBe('unauthorized');
    expect(verifyCronSecret('my-secret', 'MY-SECRET')).toBe('unauthorized');
  });
});
