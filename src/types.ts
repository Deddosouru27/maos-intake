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

export interface IdeaItem {
  text: string;
  project: string;
  actionable: boolean;
}

export interface ContentAnalysis {
  summary: string;
  ideas: IdeaItem[];
  relevance_score: number; // 0.0 – 1.0
  priority_signal: boolean;
  priority_reason: string;
  category: string;        // 'ai' | 'dev' | 'infrastructure' | 'product' | 'business' | 'other'
  language: string;        // 'ru' | 'en' | 'other'
  tags: string[];
}
