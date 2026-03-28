import path from 'path';
import { randomUUID } from 'crypto';
import youtubeDl from 'youtube-dl-exec';
import { transcribeAudio } from '../services/transcribe';
import { YouTubeMetadata } from '../types';

const MAX_DURATION_SECONDS = 30 * 60; // 30 minutes

export interface YouTubeDownloadResult {
  audioPath: string;
  title: string;
  duration: number;
}

function isYouTubeUrl(url: string): boolean {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

export async function downloadAudio(url: string): Promise<YouTubeDownloadResult> {
  if (!isYouTubeUrl(url)) {
    throw new Error(`Not a YouTube URL: ${url}`);
  }

  // Fetch metadata first to check duration before downloading
  let meta: YouTubeMetadata;
  try {
    const raw = await youtubeDl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
    });
    meta = raw as unknown as YouTubeMetadata;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT') || msg.includes('spawn') || msg.includes('not found')) {
      throw new Error('yt-dlp не установлен. Установи: pip install yt-dlp');
    }
    if (msg.includes('not available') || msg.includes('Private video')) {
      throw new Error(`Video unavailable: ${url}`);
    }
    throw new Error(`Failed to fetch YouTube metadata: ${msg}`);
  }

  if (!meta.duration || meta.duration === 0) {
    throw new Error('Could not determine video duration');
  }

  if (meta.duration > MAX_DURATION_SECONDS) {
    const minutes = Math.round(meta.duration / 60);
    throw new Error(`Video too long: ${minutes} min (max 30 min)`);
  }

  const outputPath = path.join('/tmp', `${randomUUID()}.m4a`);

  try {
    await youtubeDl(url, {
      format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      output: outputPath,
      noCheckCertificates: true,
      noWarnings: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT') || msg.includes('spawn') || msg.includes('not found')) {
      throw new Error('yt-dlp не установлен. Установи: pip install yt-dlp');
    }
    throw new Error(`Audio download failed: ${msg}`);
  }

  return {
    audioPath: outputPath,
    title: meta.title ?? 'Untitled',
    duration: meta.duration,
  };
}

export async function handleYoutube(url: string): Promise<string> {
  if (!isYouTubeUrl(url)) {
    throw new Error(`Not a YouTube URL: ${url}`);
  }

  const { audioPath } = await downloadAudio(url);
  const transcription = await transcribeAudio(audioPath);
  return transcription.text;
}
