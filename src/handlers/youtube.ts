const PROXY_URL = process.env.PROXY_WORKER_URL || '';

export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export async function fetchYouTubeText(url: string): Promise<{ title: string; text: string }> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Cannot extract video ID from URL: ${url}`);

  if (!PROXY_URL) throw new Error('PROXY_WORKER_URL not configured');

  // Step 1: Fetch page HTML via Cloudflare Worker proxy
  const pageUrl = 'https://www.youtube.com/watch?v=' + videoId;
  const proxyPageUrl = PROXY_URL + '?url=' + encodeURIComponent(pageUrl);

  console.log('[INTAKE] YouTube fetching via proxy, videoId:', videoId);
  const resp = await fetch(proxyPageUrl, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Proxy returned ${resp.status} for YouTube page`);
  const html = await resp.text();

  // Step 2: Extract title
  const titleMatch = html.match(/<title>(.+?)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : 'YouTube Video';

  // Step 3: Find captionTracks embedded in page source
  const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
  if (!captionMatch) {
    throw new Error('No captions found for video ' + videoId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tracks: any[] = JSON.parse(captionMatch[1]);

  // Priority: en → ru → first available
  const track =
    tracks.find((t) => t.languageCode === 'en') ||
    tracks.find((t) => t.languageCode === 'ru') ||
    tracks[0];

  if (!track?.baseUrl) {
    throw new Error('No caption track URL for video ' + videoId);
  }

  // Step 4: Download caption XML via proxy
  const captionProxyUrl = PROXY_URL + '?url=' + encodeURIComponent(track.baseUrl);
  const captionResp = await fetch(captionProxyUrl, { signal: AbortSignal.timeout(10000) });
  if (!captionResp.ok) throw new Error(`Proxy returned ${captionResp.status} for captions`);
  const xml = await captionResp.text();

  // Step 5: Parse XML captions to plain text
  const segments = xml.match(/<text[^>]*>(.*?)<\/text>/gs) || [];
  const text = segments
    .map((s) =>
      s
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim(),
    )
    .filter((s) => s.length > 0)
    .join(' ');

  if (text.length < 20) {
    throw new Error('Transcript too short for video ' + videoId);
  }

  console.log(`[INTAKE] YouTube transcript ok: "${title}", ${text.length} chars`);
  return { title, text };
}
