import { IntakeResult } from '../types';

// Stub — will write to maos-memory Supabase project
export async function saveToMemory(result: IntakeResult): Promise<void> {
  console.log(`[memory] stub: would save to maos-memory — source=${result.source_type}`);
  // TODO: connect to maos-memory Supabase (separate project from pitstop)
}
