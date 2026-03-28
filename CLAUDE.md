# maos-intake — инструкция для агента

## Что это
Сервис обработки контента (YouTube, статьи, Threads/Twitter).
Express + TypeScript, деплой на Vercel (Node 24.x).

## Endpoints
POST /process — { url, source } → ContentAnalysis
POST /summarize — { text, maxLength? } → { summary, keyPoints }
GET /health → { status: 'ok' }

## Ключевые файлы
- src/index.ts — Express сервер, роутинг
- src/handlers/youtube.ts — yt-dlp + Groq Whisper
- src/handlers/article.ts — cheerio text extraction
- src/handlers/threads.ts — vxtwitter + og:description
- src/services/analyze.ts — Claude Haiku анализ
- src/services/memory.ts — запись в maos-memory
- src/services/pitstop.ts — сохранение идей в Pitstop

## Env переменные
ANTHROPIC_API_KEY, GROQ_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
MEMORY_SUPABASE_URL, MEMORY_SUPABASE_ANON_KEY,
PITSTOP_SUPABASE_URL, PITSTOP_SUPABASE_ANON_KEY

## Правила
- npm run build ✅ до коммита
- Ошибки → console.error, не крашить основной поток
- Все API вызовы обернуть в try/catch

## Critical
- ideas table uses `content` NOT `title`
- Supabase project: stqhnkhcfndmhgvfyojv
