import { CohereClient } from 'cohere-ai';
import { KnowledgeItem } from '../types';

export async function rerankItems(query: string, items: KnowledgeItem[]): Promise<KnowledgeItem[]> {
  if (items.length <= 5) return items;

  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) return items;

  try {
    const cohere = new CohereClient({ token: apiKey });
    const response = await cohere.rerank({
      model: 'rerank-v3.5',
      query,
      documents: items.map((i) => ({ text: i.content })),
      topN: items.length,
    });
    console.log(`[rerank] reranked ${items.length} items`);
    return response.results.map((r) => items[r.index]);
  } catch (err) {
    console.error('[rerank] Cohere failed:', err instanceof Error ? err.message : String(err));
    return items;
  }
}
