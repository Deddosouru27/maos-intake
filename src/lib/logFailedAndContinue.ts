/**
 * Log a non-fatal failure and continue.
 * Never throws. Never logs credential values.
 * Attempts to persist to context_snapshots via REST; falls back to console.error.
 */
export function logFailedAndContinue(
  operation: string,
  err: unknown,
  context: Record<string, unknown> = {},
): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[${operation}] failed: ${message}`, Object.keys(context).length ? context : '')

  const url = process.env.PITSTOP_SUPABASE_URL
  const key = process.env.PITSTOP_SUPABASE_SERVICE_KEY ?? process.env.PITSTOP_SUPABASE_ANON_KEY
  if (!url || !key) return

  fetch(`${url}/rest/v1/context_snapshots`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      snapshot_type: 'error_log',
      content: { operation, error: message, ...context, ts: new Date().toISOString() },
    }),
  }).catch(() => { /* network error — already logged to console */ })
}
