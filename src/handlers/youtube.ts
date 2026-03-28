import * as fs from 'fs';
import * as path from 'path';
import ytdl from '@distube/ytdl-core';
import { transcribeAudio } from '../services/transcribe';

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

  const info = await ytdl.getInfo(url);
  const title = info.videoDetails.title;
  const duration = parseInt(info.videoDetails.lengthSeconds, 10);

  if (duration > 1800) {
    throw new Error(`Видео слишком длинное (>30 мин): ${Math.round(duration / 60)} мин`);
  }

  const audioPath = path.join('/tmp', `audio_${Date.now()}.mp4`);

  await new Promise<void>((resolve, reject) => {
    ytdl(url, { filter: 'audioonly', quality: 'lowestaudio' })
      .pipe(fs.createWriteStream(audioPath))
      .on('finish', resolve)
      .on('error', reject);
  });

  return { audioPath, title, duration };
}

export async function handleYoutube(url: string): Promise<string> {
  if (!isYouTubeUrl(url)) {
    throw new Error(`Not a YouTube URL: ${url}`);
  }

  const { audioPath } = await downloadAudio(url);
  const transcription = await transcribeAudio(audioPath);
  return transcription.text;
}
