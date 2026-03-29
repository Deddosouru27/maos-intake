import { YoutubeTranscript } from 'youtube-transcript-plus';

function extractVideoId(url: string): string | null {
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

  let segments: { text: string }[];
  let title = 'YouTube video';

  try {
    // Try with videoDetails to get title
    const result = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: 'ru',
      videoDetails: true,
    });

    if (Array.isArray(result)) {
      segments = result;
    } else {
      segments = result.segments;
      title = result.videoDetails?.title || title;
    }
  } catch {
    // Fallback to English
    try {
      const result = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
      segments = Array.isArray(result) ? result : (result as { segments: { text: string }[] }).segments;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If blocked on Vercel — return a helpful error
      throw new Error(
        `YouTube временно недоступен (${msg}). Попробуйте через youtubetotranscript.com и отправьте текст как /idea`,
      );
    }
  }

  if (!segments || segments.length === 0) {
    throw new Error(
      'No captions available for this video. Попробуйте через youtubetotranscript.com и отправьте текст как /idea',
    );
  }

  const text = segments.map((s) => s.text).join(' ');
  return { title, text };
}

// Legacy download+Whisper kept for future Railway deployment (no IP blocking)
// import ytdl from '@distube/ytdl-core';
// export async function downloadAudio(url: string): Promise<{ audioPath, title, duration }> { ... }
