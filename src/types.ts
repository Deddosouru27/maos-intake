export interface IntakeSource {
  type: 'youtube' | 'article' | 'text';
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
