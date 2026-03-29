import { getVideoDetails } from 'youtube-caption-extractor';

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

  // Try Russian first, then English
  let details = await getVideoDetails({ videoID: videoId, lang: 'ru' });
  if (!details.subtitles || details.subtitles.length === 0) {
    details = await getVideoDetails({ videoID: videoId, lang: 'en' });
  }

  if (!details.subtitles || details.subtitles.length === 0) {
    throw new Error('No captions available for this video');
  }

  const text = details.subtitles.map((s: { text: string }) => s.text).join(' ');
  return {
    title: details.title || 'YouTube video',
    text,
  };
}

// Legacy download+transcribe kept for future use (Railway deployment with Whisper)
// export async function downloadAudio(url: string): Promise<YouTubeDownloadResult> { ... }
