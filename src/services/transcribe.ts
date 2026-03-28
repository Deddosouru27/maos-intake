import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';

export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
}

const SUPPORTED_FORMATS = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac'];

export async function transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
  const ext = path.extname(audioPath).toLowerCase();
  if (!SUPPORTED_FORMATS.includes(ext)) {
    throw new Error(`Unsupported audio format: ${ext}. Supported: ${SUPPORTED_FORMATS.join(', ')}`);
  }

  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const fileStream = fs.createReadStream(audioPath);

  // verbose_json returns language + duration but SDK types only expose `text`
  const raw = await groq.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-large-v3-turbo',
    response_format: 'verbose_json',
  }) as unknown as { text: string; language?: string; duration?: number };

  // Clean up temp file after transcription
  try {
    fs.unlinkSync(audioPath);
  } catch {
    console.warn(`Could not delete temp file: ${audioPath}`);
  }

  return {
    text: raw.text,
    language: raw.language ?? 'unknown',
    duration: raw.duration ?? 0,
  };
}
