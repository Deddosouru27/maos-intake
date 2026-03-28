# maos-intake

Content intake service for MAOS. Processes URLs (YouTube, articles) and raw text — analyzes via Claude Haiku — saves to Supabase ideas table.

## What it does

1. Polls Supabase `ideas` table for `status = 'pending'` rows
2. Routes by source type: YouTube → download audio → Groq Whisper transcription; article → fetch HTML → extract text
3. Analyzes content with Claude Haiku
4. Saves result back to Supabase

## Stack

- Node.js + TypeScript (strict)
- [youtube-dl-exec](https://github.com/nicholasgasior/youtube-dl-exec) — yt-dlp wrapper for YouTube audio
- [groq-sdk](https://github.com/groq/groq-typescript) — Whisper transcription (whisper-large-v3-turbo)
- [@anthropic-ai/sdk](https://github.com/anthropic/anthropic-sdk-node) — Claude Haiku analysis
- [@supabase/supabase-js](https://github.com/supabase/supabase-js) — database

## Requirements

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and available in PATH (for YouTube handler)

## Setup

```bash
cp .env.example .env
# fill in values
npm install
npm run build
```

## Commands

```bash
npm run dev      # start polling mode (polls every 10s)
npm run process  # process a single URL/text from CLI
npm run build    # TypeScript compile
```

## Env variables

| Variable | Description |
|---|---|
| `GROQ_API_KEY` | Groq API key — free tier, used for Whisper transcription |
| `ANTHROPIC_API_KEY` | Anthropic API key — Claude Haiku analysis |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `PROJECT_ID` | Pitstop project ID for tagging saved ideas |
| `TELEGRAM_BOT_TOKEN` | (optional) Telegram bot for notifications |
| `TELEGRAM_CHAT_ID` | (optional) Telegram chat ID for notifications |

## Structure

```
src/
  handlers/
    youtube.ts      # download audio via yt-dlp → transcribe via Groq
    article.ts      # fetch URL → extract text
    instagram.ts    # stub (TODO)
    text.ts         # raw text passthrough
  services/
    transcribe.ts   # Groq Whisper API
    analyze.ts      # Claude Haiku analysis (stub, real in analyzer.ts)
    memory.ts       # maos-memory write stub
  analyzer.ts       # real Claude Haiku analysis
  supabase.ts       # Supabase helpers
  types.ts          # TypeScript interfaces
  index.ts          # polling entry point
  process.ts        # CLI entry point
```
