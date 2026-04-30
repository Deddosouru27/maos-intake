export interface DiscoveredRepo {
  repo_full_name: string;
  language: string | null;
  stars_total: number | null;
  stars_gained: number | null;
  description: string | null;
  source: string;
}

export interface DiscoveredSkill {
  repo_url: string;
  commit_url: string | null;
  skill_content: string | null;
  source: string;
}

export interface TrendingResult {
  status: 'ok' | 'partial' | 'error';
  discovered: number;
  skipped: number;
  errors: string[];
}

export interface AwesomeListResult {
  status: 'ok' | 'partial' | 'error';
  feeds_checked: number;
  new_commits: number;
  repos_discovered: number;
  errors: string[];
}

export interface BigQuerySkillsResult {
  status: 'ok' | 'skipped' | 'error';
  rows_scanned: number;
  skills_discovered: number;
  error?: string;
}

export interface ExtractionResult {
  status: 'ok' | 'skipped' | 'error';
  repos_processed: number;
  skills_processed: number;
  knowledge_saved: number;
  errors: string[];
}
