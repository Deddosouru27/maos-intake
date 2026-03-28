import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import { IntakeResult } from './types';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

export async function saveIdea(result: IntakeResult, projectId: string): Promise<void> {
  const { error } = await supabase.from('ideas').insert({
    content: result.summary,
    summary: result.summary,
    extracted_ideas: result.extracted_ideas,
    relevance: result.relevance,
    source_type: result.source_type,
    source_url: result.source_url,
    status: 'new',
    project_id: projectId,
    ai_analysis: {
      full_content: result.content,
      processing_date: new Date(),
    },
  });

  if (error) {
    throw new Error(`Supabase insert failed: ${error.message}`);
  }
}
