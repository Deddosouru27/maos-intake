import * as cheerio from 'cheerio';

const CHANNELS = ['prompt_design', 'your_pet_project', 'whackdoor', 'ventureStuff', 'rcp_ai'];
const INTAKE_URL = 'https://maos-intake.vercel.app/api/ingest/telegram';
const PAUSE_MS = 2000;

interface TgPost {
  post_id: string;
  text: string;
  date?: string;
  has_file: boolean;
  file_name?: string;
}

async function scrapeChannel(channel: string): Promise<TgPost[]> {
  const url = `https://t.me/s/${channel}`;
  console.log(`  Fetching ${url}...`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const posts: TgPost[] = [];
  $('.tgme_widget_message_wrap[data-post]').each((_, el) => {
    const dataPost = $(el).attr('data-post') ?? '';
    const post_id = dataPost.split('/').pop() ?? '';
    const text = $(el).find('.tgme_widget_message_text').text().replace(/\s+/g, ' ').trim();
    const date = $(el).find('time[datetime]').attr('datetime');
    const has_file = $(el).find('.tgme_widget_message_document').length > 0;
    const file_name = has_file
      ? $(el).find('.tgme_widget_message_document_title').text().trim() || undefined
      : undefined;

    if (post_id && text) {
      posts.push({ post_id, text, date, has_file, file_name });
    }
  });

  return posts;
}

async function ingestChannel(channel: string): Promise<void> {
  console.log(`\n[${channel}]`);
  let posts: TgPost[];

  try {
    posts = await scrapeChannel(channel);
    console.log(`  Scraped: ${posts.length} posts`);
  } catch (err) {
    console.error(`  SCRAPE ERROR: ${(err as Error).message}`);
    return;
  }

  if (posts.length === 0) {
    console.log('  No posts found, skipping.');
    return;
  }

  try {
    const res = await fetch(INTAKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, posts }),
    });

    const body = await res.json();
    if (!res.ok) {
      console.error(`  POST ERROR ${res.status}:`, JSON.stringify(body));
      return;
    }

    console.log(`  processed=${body.processed ?? '?'}  skipped=${body.skipped ?? '?'}  failed=${body.failed ?? '?'}  cost=$${body.cost?.toFixed(4) ?? '?'}`);
  } catch (err) {
    console.error(`  POST ERROR: ${(err as Error).message}`);
  }
}

async function main() {
  console.log(`Bulk TG ingest — ${CHANNELS.length} channels`);
  console.log(`Target: ${INTAKE_URL}\n`);

  for (let i = 0; i < CHANNELS.length; i++) {
    await ingestChannel(CHANNELS[i]);
    if (i < CHANNELS.length - 1) {
      console.log(`  (pause ${PAUSE_MS}ms)`);
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
