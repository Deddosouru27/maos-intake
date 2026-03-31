import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

export async function fetchInstagramTranscript(url: string): Promise<{ title: string; text: string } | null> {
  if (!process.env.APIFY_API_TOKEN) return null;

  const timeout = setTimeout(() => {
    throw new Error('Apify timeout');
  }, 30000);

  try {
    const run = await client.actor('apify/instagram-reel-scraper').call({
      urls: [url],
      resultsLimit: 1,
    });
    clearTimeout(timeout);

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    if (!items.length) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reel = items[0] as any;
    const transcript = reel.transcript || '';
    const caption = reel.caption || '';
    const text = transcript || caption;

    if (!text || text.length < 20) return null;

    return {
      title: reel.ownerUsername ? `Instagram @${reel.ownerUsername}` : 'Instagram Reel',
      text,
    };
  } catch (e) {
    clearTimeout(timeout);
    console.log('[INTAKE] Apify error:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
