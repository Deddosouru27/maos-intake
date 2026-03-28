export interface IntakeSource {
  type: 'youtube' | 'article' | 'text' | 'instagram';
  url?: string;
  raw_text?: string;
}

export interface IntakeResult {
  content: string;
  summary: string;
  extracted_ideas: string[];
  relevance: 'hot' | 'interesting' | 'noise';
  source_type: string;
  source_url?: string;
}

export interface IntakeJob {
  id: string;
  url: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  result?: IntakeResult;
  error?: string;
}

export interface YouTubeMetadata {
  title: string;
  duration: number;        // seconds
  uploader?: string;
  upload_date?: string;    // YYYYMMDD
  description?: string;
  webpage_url?: string;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;        // seconds
}

export type IdeaCategory = 'feature' | 'marketing' | 'ux' | 'bug' | 'infra' | 'business' | 'other';

export interface ContentAnalysis {
  summary: string;
  ideas: string[];
  relevance_score: number; // 0.0 – 1.0
  priority_signal: boolean;
  tags: string[];
  category: IdeaCategory;
}
