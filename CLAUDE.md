# CLAUDE.md — maos-intake

## What is this
Content intake service for MAOS. Processes URLs (articles, YouTube), text → analyzes via Claude Haiku → saves to Pitstop Supabase ideas table.

## Stack
Node.js + TypeScript, runs locally (not serverless).

## Commands
npm run build — TypeScript compile
npm run dev — start polling mode
npm run process — CLI: process single URL/text

## Critical
- ideas table uses `content` NOT `title`
- Supabase project: stqhnkhcfndmhgvfyojv
- Always npm run build before commit
