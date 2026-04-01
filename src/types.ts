export interface YouTubeMetadata {
  title: string;
  duration: number;
  uploader?: string;
  upload_date?: string;
  description?: string;
  webpage_url?: string;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
}

export type KnowledgeType =
  | 'actionable_idea'
  | 'tool_or_library'
  | 'architecture_pattern'
  | 'code_snippet'
  | 'insight'
  | 'technique'
  | 'case_study'
  | 'strategic_idea'
  | 'lesson_learned'
  | 'guide';

export type EffortLevel = 'trivial' | 'low' | 'medium' | 'high' | 'huge';
export type RoutedTo = 'hot_backlog' | 'knowledge_base' | 'discarded';

export interface KnowledgeItem {
  content: string;
  knowledge_type: KnowledgeType;
  project: string | null;
  domains: string[];
  solves_need: string | null;
  immediate_relevance: number;
  strategic_relevance: number;
  novelty: number;
  effort: EffortLevel;
  has_ready_code: boolean;
  business_value: string | null;
  tags: string[];
}

export interface RoutedKnowledgeItem extends KnowledgeItem {
  routed_to: RoutedTo;
}

export interface BrainAnalysis {
  summary: string;
  knowledge_items: KnowledgeItem[];
  overall_immediate: number;
  overall_strategic: number;
  priority_signal: boolean;
  priority_reason: string;
  category: string;
  language: string;
  _haiku_raw?: string;
}
