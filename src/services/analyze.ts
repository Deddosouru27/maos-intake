import Anthropic from '@anthropic-ai/sdk';
import { ContentAnalysis } from '../types';
import { getProjectContext, buildProjectContextPrompt } from './projectContext';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sendTelegramAlert(source: string, analysis: ContentAnalysis): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const ideas = analysis.ideas.map((i) => `• [${i.project}] ${i.text}`).join('\n');
  const reason = analysis.priority_reason ? `\nПричина: ${analysis.priority_reason}` : '';
  const text = `🚨 Приоритетный контент из ${source}:\n${analysis.summary}\n\nИдеи:\n${ideas}${reason}`;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error('[analyze] Telegram alert failed:', err);
  }
}

export async function analyzeContent(text: string, source: string): Promise<ContentAnalysis> {
  const truncated = text.length > 8000 ? text.slice(0, 8000) + '...' : text;

  const projects = await getProjectContext();
  const projectsSection = buildProjectContextPrompt(projects);

  const systemPrompt = `Ты — аналитик контента для системы MAOS. Твоя единственная задача — находить практически применимые идеи для конкретных проектов команды.

## Проекты команды (загружены из базы данных)

${projectsSection}

## Как анализировать

ШАГ 1 — ПОНИМАНИЕ: Прочитай контент. Определи основную тему.

ШАГ 2 — ФИЛЬТРАЦИЯ: Для каждого проекта из списка выше спроси себя: "Есть ли в этом контенте что-то конкретно применимое к этому проекту?" Не натягивай — если связь слабая или абстрактная, не включай.

ШАГ 3 — ИЗВЛЕЧЕНИЕ: Запиши только идеи с конкретным действием. "Добавить streak-механику в Life RPG по аналогии с Duolingo" — хорошо. "Геймификация полезна для мотивации" — плохо (слишком абстрактно).

ШАГ 4 — ОЦЕНКА: relevance_score — это доля контента которая реально полезна для наших проектов. Статья полностью про кулинарию = 0.0-0.1. Статья про AI агентов = 0.7-0.9. Статья про AI агентов с конкретными архитектурными решениями которые мы можем применить = 0.9-1.0.

## Строгие правила

1. ВСЕ ответы и идеи ТОЛЬКО на русском языке, даже если контент на английском.

2. Каждая идея ОБЯЗАНА содержать: конкретное действие + к какому проекту относится. "Интересная мысль про AI" — ЗАПРЕЩЕНО. "Добавить в Runner retry с exponential backoff как описано в статье" — ПРАВИЛЬНО.

3. Если контент ПОЛНОСТЬЮ нерелевантен всем проектам (кулинария, спорт, личная жизнь блогера, политика без связи с технологиями, развлекательный контент без полезных идей) — верни relevance_score: 0.0, ideas: [], summary описывает о чём контент и почему он нерелевантен.

4. НЕ ВЫДУМЫВАЙ идеи которых нет в контенте. Если в видео про жизнь в США нет идей для наших проектов — так и скажи. Не пытайся натянуть "ну можно же сделать приложение для эмигрантов".

5. priority_signal: true ТОЛЬКО если контент содержит:
   — Критический баг или уязвимость в технологиях которые мы используем (Supabase, Vercel, Anthropic, Vite, React)
   — Новый инструмент или API который ПРЯМО решает текущую проблему из наших проектов
   — Существенное удешевление или улучшение используемых нами сервисов
   — Готовое open-source решение которое заменяет то что мы сейчас пишем сами

6. Максимум 5 идей. Лучше 2 сильных чем 5 слабых.

7. Tags — на русском, конкретные, не общие. "автоматизация тестов" — хорошо. "технологии" — плохо.`;

  const userPrompt = `Проанализируй контент и верни ТОЛЬКО валидный JSON без markdown-обёртки, без \`\`\`json, без пояснений — только JSON:

{
  "summary": "2-3 предложения на русском — о чём контент и почему он релевантен/нерелевантен нашим проектам",
  "ideas": [
    {
      "text": "конкретное действие на русском",
      "project": "название проекта из списка выше",
      "actionable": true
    }
  ],
  "relevance_score": 0.0,
  "priority_signal": false,
  "priority_reason": "",
  "category": "ai",
  "language": "ru",
  "tags": ["тег1", "тег2"]
}

Если контент нерелевантен — ideas: [], relevance_score: 0.0-0.1.

Контент для анализа:
${truncated}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';

  let parsed: ContentAnalysis;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as ContentAnalysis;
  } catch {
    throw new Error(`Failed to parse Haiku response: ${raw}`);
  }

  if (parsed.priority_signal) {
    await sendTelegramAlert(source, parsed);
  }

  return parsed;
}
