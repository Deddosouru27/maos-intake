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

  // Dynamic import — package is ESM, project is CommonJS
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: TranscriptClient } = await import('youtube-transcript-api') as any;

  const client = new TranscriptClient({
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    },
  });

  await client.ready;
  const result = await client.getTranscript(videoId);

  const text =
    result.languages?.[0]?.transcript
      ?.map((s: { text: string }) => s.text)
      .join(' ') || '';

  if (!text) {
    throw new Error(
      'No captions available for this video. Попробуйте через youtubetotranscript.com и отправьте текст как /idea',
    );
  }

  return { title: result.title || 'YouTube video', text };
}

// Legacy download+Whisper kept for future Railway deployment (no IP blocking)
// import ytdl from '@distube/ytdl-core';
// export async function downloadAudio(url): Promise<{ audioPath, title, duration }> { ... }
