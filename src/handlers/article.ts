import * as cheerio from 'cheerio';

const MAX_TEXT_LENGTH = 10_000;

// Elements to remove before extracting text
const NOISE_SELECTORS = [
  'nav', 'header', 'footer', 'aside',
  '[class*="nav"]', '[class*="menu"]', '[class*="footer"]',
  '[class*="sidebar"]', '[class*="banner"]', '[class*="cookie"]',
  '[class*="ad-"]', '[class*="-ad"]', '[id*="nav"]',
  '[id*="menu"]', '[id*="footer"]', '[id*="sidebar"]',
  'script', 'style', 'noscript',
];

function extractText($: cheerio.CheerioAPI): string {
  // Try semantic content containers first
  const contentSelectors = ['article', 'main', '[role="main"]', '.post-content', '.entry-content', '.article-body'];
  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length) {
      NOISE_SELECTORS.forEach((s) => el.find(s).remove());
      const text = el.text().replace(/\s+/g, ' ').trim();
      if (text.length > 200) return text;
    }
  }

  // Fallback: collect all <p> tags
  NOISE_SELECTORS.forEach((s) => $(s).remove());
  const paragraphs: string[] = [];
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 40) paragraphs.push(text);
  });
  return paragraphs.join(' ').trim();
}

export async function fetchWithJina(url: string): Promise<{ text: string; title: string } | null> {
  try {
    const resp = await fetch('https://r.jina.ai/' + url, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text || text.length < 50) return null;
    const titleMatch = text.match(/^Title:\s*(.+)/m);
    return {
      title: titleMatch?.[1]?.trim() || 'Article',
      text: text.substring(0, 50000),
    };
  } catch {
    console.log('[INTAKE] Jina failed, falling back to readability');
    return null;
  }
}

export async function fetchArticle(url: string): Promise<{ text: string; title: string }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; maos-intake/1.0)' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch article: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new Error(`Not an HTML page: ${contentType}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';

  let text = extractText($);
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH);
  }

  if (!text) {
    throw new Error(`Could not extract text content from: ${url}`);
  }

  return { text, title };
}

// Legacy alias used by polling code
export async function handleArticle(url: string): Promise<string> {
  const { text } = await fetchArticle(url);
  return text;
}
