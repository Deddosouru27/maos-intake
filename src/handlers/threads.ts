import * as cheerio from 'cheerio';

export interface ThreadResult {
  text: string;
  author: string;
  platform: 'twitter' | 'threads';
}

// vxtwitter free API — no keys required
// https://api.vxtwitter.com/{username}/status/{id}
async function fetchTwitter(url: string): Promise<ThreadResult> {
  // Extract tweet ID from URL: twitter.com/user/status/123 or x.com/user/status/123
  const match = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
  if (!match) {
    return { text: '', author: '', platform: 'twitter' };
  }

  const [, username, tweetId] = match;
  const apiUrl = `https://api.vxtwitter.com/${username}/status/${tweetId}`;

  try {
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; maos-intake/1.0)' },
    });
    if (!response.ok) {
      return { text: '', author: username, platform: 'twitter' };
    }

    const data = await response.json() as { text?: string; user_name?: string };
    return {
      text: data.text ?? '',
      author: data.user_name ?? username,
      platform: 'twitter',
    };
  } catch (e) {
    console.warn('[fetchTwitter] failed:', e instanceof Error ? e.message : String(e));
    return { text: '', author: username, platform: 'twitter' };
  }
}

// Threads: fetch page and extract og:description meta tag
async function fetchThreads(url: string): Promise<ThreadResult> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; maos-intake/1.0)' },
    });
    if (!response.ok) {
      return { text: '', author: '', platform: 'threads' };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      '';

    const author =
      $('meta[property="og:title"]').attr('content') ||
      '';

    return {
      text: description.trim(),
      author: author.trim(),
      platform: 'threads',
    };
  } catch (e) {
    console.warn('[fetchThreads] failed:', e instanceof Error ? e.message : String(e));
    return { text: '', author: '', platform: 'threads' };
  }
}

export async function fetchThread(url: string): Promise<ThreadResult> {
  if (url.includes('threads.net')) {
    return fetchThreads(url);
  }
  return fetchTwitter(url);
}
