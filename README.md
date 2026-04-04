# maos-intake

Content intake service for MAOS. Processes URLs (YouTube, Instagram, articles) and raw text — analyzes via Claude Haiku — saves extracted knowledge to Supabase.

## What it does

1. Receives URLs via `POST /process` (from Pitstop or Telegram)
2. Routes by source type: YouTube → transcript; Instagram → Apify scraper → Groq Whisper; article → Jina/readability
3. Analyzes content with Claude Haiku (scoring, routing, entity extraction)
4. Saves to Supabase: `extracted_knowledge`, `ideas`, `ingested_content`, `context_snapshots`, `entity_nodes`

## Stack

- Node.js 24 + TypeScript + Express
- Claude Haiku — knowledge extraction and scoring
- OpenAI text-embedding-3-small — semantic dedup embeddings
- Groq Whisper — audio transcription (Instagram/YouTube)
- Apify — Instagram scraper
- Supabase — Pitstop DB (ideas, knowledge, context)

## Deploy on Railway

1. Fork / connect this repo to [Railway](https://railway.app)
2. Set **Build Command**: `npm run build`
3. Set **Start Command**: `node dist/index.js`
4. Add all env variables from `.env.example` (Railway → Variables tab)
5. Deploy — Railway auto-rebuilds on every push

`railway.json` and `Procfile` are already configured.

## Local dev

```bash
cp .env.example .env
# fill in values
npm install
npm run dev      # tsx src/index.ts (hot reload)
npm run build    # compile to dist/
```

## Env variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | auto | Set by Railway automatically |
| `ANTHROPIC_API_KEY` | yes | Claude Haiku extraction |
| `OPENAI_API_KEY` | recommended | Embeddings for semantic dedup |
| `GROQ_API_KEY` | yes | Whisper audio transcription |
| `COHERE_API_KEY` | optional | Reranking (skipped if missing) |
| `PITSTOP_SUPABASE_URL` | yes | Pitstop Supabase project URL |
| `PITSTOP_SUPABASE_ANON_KEY` | yes | Pitstop anon key |
| `APIFY_API_TOKEN` | yes | Instagram scraper |
| `TELEGRAM_BOT_TOKEN` | optional | Priority alerts |
| `TELEGRAM_CHAT_ID` | optional | Priority alerts |
| `PROXY_WORKER_URL` | optional | YouTube geo-block proxy |

## Key endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Health ping |
| GET | `/health` | Full health check with Supabase stats |
| POST | `/process` | Process a single URL or text paste |
| POST | `/process/batch` | Process up to 10 URLs in parallel |
| GET | `/stats` | Processing statistics |

## Structure

```
src/
  handlers/        # source-specific fetchers (youtube, article, instagram, threads, file)
  services/        # analyze (Haiku), pitstop (Supabase), rerank (Cohere), transcribe (Groq)
  apify.ts         # Instagram scraper via Apify
  types.ts         # TypeScript interfaces
  index.ts         # Express app + all endpoints
```
