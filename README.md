# maos-intake

Knowledge ingestion pipeline for MAOS. Processes URLs (YouTube, Instagram, articles), audio, video, and text into structured knowledge with entity extraction, scoring, and routing.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in API keys
npm run dev             # local dev on port 3001 (tsx hot reload)
npm run build           # compile to dist/
```

## Deploy

```bash
# Vercel (primary)
npx vercel --prod --force --yes

# Railway (alternative) — railway.json and Procfile configured
```

## Architecture

```
URL / text → detectSource() → fetchRawContent() → dedup → analyzeWithChunking (Haiku)
  → routeItems() → saveExtractedKnowledge + saveToPitstop + upsertEntityGraph
  → writeContextSnapshot (WAA)
```

```
src/
  handlers/        # source-specific fetchers (youtube, article, instagram, threads, file)
  services/        # analyze (Haiku), pitstop (Supabase), rerank (Cohere), transcribe (Groq)
  apify.ts         # Instagram scraper via Apify
  types.ts         # TypeScript interfaces
  index.ts         # Express app + all endpoints
```

---

## API Endpoints

Base URL: production or `http://localhost:3001`

### Health & Monitoring

#### `GET /status`

Lightweight health ping, no DB calls.

```bash
curl http://localhost:3001/status
```

```json
{ "status": "ok", "service": "maos-intake", "timestamp": "2026-04-08T12:00:00Z", "version": "1.0" }
```

#### `GET /health`

Full health check with Supabase counts, service key status. HTTP 503 if degraded.

```bash
curl http://localhost:3001/health

# Preflight mode (also tests Telegram + pending tasks)
curl "http://localhost:3001/health?preflight=true"
```

```json
{
  "status": "ok",
  "knowledge_count": 150,
  "knowledge_without_embedding": 0,
  "entity_count": 80,
  "pending_ingestion": 0,
  "supabase": "connected",
  "services": { "anthropic": "connected", "openai": "connected" }
}
```

#### `GET /heartbeat`

Cron heartbeat with auto-maintenance: quality counts, entity backfill, daily auto-discover, Telegram report.

```bash
curl http://localhost:3001/heartbeat
```

```json
{
  "ts": "2026-04-08T12:00:00Z",
  "knowledge_count": 150,
  "entity_count": 80,
  "entity_objects_missing": 5,
  "pending_ingestion": 0,
  "backfill": { "processed": 5, "remaining": 0 }
}
```

#### `GET /stats`

Processing statistics.

```bash
curl http://localhost:3001/stats
```

```json
{
  "processed_today": 5,
  "total_processed": 320,
  "knowledge_items": 1200,
  "memory_entries": 45,
  "uptime_seconds": 3600
}
```

---

### Content Processing

#### `POST /process`

Main ingestion endpoint. Single URL or text paste. Rate limit: 10 req/min.

```bash
# URL mode
curl -X POST http://localhost:3001/process \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'

# Text paste mode
curl -X POST http://localhost:3001/process \
  -H "Content-Type: application/json" \
  -d '{"text": "Your article text here...", "title": "My Article", "source_type": "text"}'

# Batch text (split by --- separator, up to 10 parts)
curl -X POST http://localhost:3001/process \
  -H "Content-Type: application/json" \
  -d '{"text": "First article...\n---\nSecond article...", "title": "Batch"}'
```

```json
{
  "success": true,
  "status": "done",
  "knowledge_count": 5,
  "source_url": "https://...",
  "notification": "🔥 2 идей для текущих задач",
  "summary": "...",
  "knowledge_items": [...]
}
```

#### `POST /process/batch`

Parallel batch processing with retry (3 attempts, 30s/120s backoff). Up to 10 URLs. Rate limit: 10 req/min.

```bash
curl -X POST http://localhost:3001/process/batch \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com/article1", "https://example.com/article2"]}'
```

```json
{
  "success": true,
  "results": [
    { "url": "...", "status": "success", "knowledge_count": 3, "attempts": 1 },
    { "url": "...", "status": "skipped", "reason": "duplicate" }
  ],
  "summary": { "success": 1, "skipped": 1, "errors": 0 }
}
```

#### `POST /process-file`

File upload (PDF, DOCX, XLSX). Send base64-encoded buffer. Rate limit: 10 req/min.

```bash
curl -X POST http://localhost:3001/process-file \
  -H "Content-Type: application/json" \
  -d '{"buffer": "<base64>", "filename": "report.pdf", "mime_type": "application/pdf"}'
```

#### `POST /batch` *(deprecated)*

Legacy batch. Use `POST /process/batch` instead.

---

### Triage

#### `POST /triage`

Per-idea Haiku triage with calibration few-shots. Processes ideas with status='new'.

```bash
curl -X POST http://localhost:3001/triage \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}'
```

```json
{
  "processed": 10,
  "approved": 4,
  "rejected": 5,
  "needs_clarification": 1,
  "details": [{ "id": "uuid", "content": "...", "decision": "approve", "reason": "..." }]
}
```

#### `POST /auto-triage`

Batch triage all new ideas via Haiku LLM (batches of 20). Can promote ideas to tasks.

```bash
curl -X POST http://localhost:3001/auto-triage
```

```json
{
  "success": true,
  "approved": 15,
  "rejected": 30,
  "tasks": 3,
  "errors": 0,
  "report": "Auto-triage: 15 approved, 30 rejected, 3 → tasks"
}
```

#### `POST /triage-all`

Bulk keyword triage, zero LLM cost. Scores by relevance/effort/impact. Top 15% approved, bottom 35% rejected, rest for review.

```bash
curl -X POST http://localhost:3001/triage-all
```

```json
{
  "processed": 100,
  "approved": 15,
  "rejected": 35,
  "review": 50,
  "top_5": [{ "id": "...", "content": "...", "priority": 8.5 }],
  "bottom_5": [{ "id": "...", "content": "...", "priority": 0.5 }]
}
```

---

### Discovery

#### `POST /auto-discover`

Discover new content by topics via YouTube search (max 10 topics).

```bash
curl -X POST http://localhost:3001/auto-discover \
  -H "Content-Type: application/json" \
  -d '{"topics": ["supabase pgvector", "claude tool use"]}'
```

```json
{ "discovered": 12, "by_topic": { "supabase pgvector": 7, "claude tool use": 5 } }
```

#### `POST /process-discovery`

Process pending items from content_discovery table. Rate limit: 10 req/min.

```bash
curl -X POST http://localhost:3001/process-discovery \
  -H "Content-Type: application/json" \
  -d '{"limit": 5}'
```

```json
{
  "processed": 3,
  "failed": 1,
  "remaining": 8,
  "details": [{ "url": "...", "status": "done" }, { "url": "...", "status": "duplicate" }]
}
```

---

### Analysis & Utilities

#### `POST /summarize`

Summarize text without saving to DB. Uses Claude Haiku.

```bash
curl -X POST http://localhost:3001/summarize \
  -H "Content-Type: application/json" \
  -d '{"text": "Long article text...", "maxLength": 100}'
```

```json
{ "summary": "...", "keyPoints": ["Point 1", "Point 2"] }
```

#### `GET /quality-report`

Scoring distribution audit. Random sample of 20 items + aggregate stats.

```bash
curl http://localhost:3001/quality-report
```

```json
{
  "total_records": 500,
  "sample": [...],
  "stats": {
    "hot_count": 50, "mid_count": 200, "low_count": 250,
    "avg_immediate": 0.42, "avg_strategic": 0.55, "hot_pct": 10.0
  }
}
```

#### `GET /api/rejected`

List URLs rejected by pre-filter (too short or wrong language). Last 50 items.

```bash
curl http://localhost:3001/api/rejected
```

```json
{
  "count": 5,
  "rejected": [{ "source_url": "...", "reason": "word_count=42", "created_at": "..." }]
}
```

---

### Backfill & Maintenance

#### `POST /backfill-embeddings`

Generate missing OpenAI embeddings (text-embedding-3-small, 512 dim). 10 rows per call.

```bash
curl -X POST http://localhost:3001/backfill-embeddings
```

```json
{ "processed": 10, "remaining": 25 }
```

#### `POST /backfill-entities`

Extract entity graph from existing knowledge via Haiku. 10 rows per call.

```bash
curl -X POST http://localhost:3001/backfill-entities
```

```json
{ "processed": 10, "remaining": 15 }
```

#### `POST /backfill-edge-types`

Replace generic `co_occurs` edges with inferred relationship types (competes_with, uses, implements, etc.).

```bash
curl -X POST http://localhost:3001/backfill-edge-types
```

```json
{ "updated": 45, "total_co_occurs": 50 }
```

#### `POST /label-clusters`

Auto-label knowledge clusters via keyword frequency. Zero LLM cost.

```bash
curl -X POST http://localhost:3001/label-clusters
```

```json
{ "labeled": 8, "clusters": [{ "cluster_id": "1", "label": "Supabase, Vector, Embedding", "count": 12 }] }
```

---

## Supported Sources

| Source | Detection | Method |
|---|---|---|
| YouTube | `youtube.com`, `youtu.be` | Gemini (primary) or transcript + Haiku |
| Instagram | `instagram.com` | Apify scraper + Groq Whisper |
| Articles | `habr.com`, `medium.com`, `dev.to`, etc. | Jina Reader + cheerio fallback |
| Threads | `threads.net`, `x.com`, `twitter.com` | Thread handler |
| Text/Files | Manual paste or file upload | Direct to Haiku pipeline |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude Haiku for analysis & triage |
| `OPENAI_API_KEY` | Yes | Embeddings (text-embedding-3-small, 512 dim) |
| `PITSTOP_SUPABASE_URL` | Yes | Supabase project URL |
| `PITSTOP_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `GEMINI_API_KEY` | No | Gemini for native YouTube video analysis |
| `GROQ_API_KEY` | No | Groq Whisper for audio transcription |
| `COHERE_API_KEY` | No | Reranking (skipped if missing) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat for heartbeat reports |
| `APIFY_API_TOKEN` | No | Apify for Instagram scraping |
| `PROXY_WORKER_URL` | No | YouTube geo-block proxy |
