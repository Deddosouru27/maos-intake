import 'dotenv/config';

export const config = {
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
  anthropicKey: process.env.ANTHROPIC_API_KEY!,
  projectId: process.env.PROJECT_ID || 'стоит заполнить',
};
