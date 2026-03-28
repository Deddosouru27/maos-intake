import { convert } from 'html-to-text';

export async function fetchArticle(url: string): Promise<{ text: string; title: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch article: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new Error(`Not an HTML page: ${contentType}`);
  }
  const html = await response.text();
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
    ],
  });
  return { text: text.trim(), title: '' };
}

// Legacy alias used by polling code
export async function handleArticle(url: string): Promise<string> {
  const { text } = await fetchArticle(url);
  return text;
}
