export async function fetchInstagramTranscript(url: string): Promise<{ title: string; text: string; sourceType: string } | null> {
  const apifyToken = process.env.APIFY_API_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;
  if (!apifyToken) { console.log('[APIFY] TOKEN MISSING'); return null; }

  try {
    console.log('[APIFY] Starting for:', url);

    // Step 1: Start actor via HTTP API
    const startResp = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-reel-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directUrls: [url], resultsLimit: 1 }),
        signal: AbortSignal.timeout(45000),
      },
    );

    if (!startResp.ok) {
      console.log('[APIFY] Start failed:', startResp.status, await startResp.text().catch(() => ''));
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runData = await startResp.json() as any;
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;
    console.log('[APIFY] Run started:', runId, 'dataset:', datasetId);

    // Step 2: Poll for completion (every 3s, max 40s)
    let status = runData.data?.status;
    let attempts = 0;
    while (status !== 'SUCCEEDED' && status !== 'FAILED' && attempts < 13) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pollData = await pollResp.json() as any;
      status = pollData.data?.status;
      attempts++;
      console.log('[APIFY] Poll:', status, 'attempt:', attempts);
    }

    if (status !== 'SUCCEEDED') {
      console.log('[APIFY] Run failed/timeout:', status);
      return null;
    }

    // Step 3: Fetch results
    const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await itemsResp.json() as any[];
    console.log('[APIFY] Items:', items.length);

    if (!items.length) return null;
    const reel = items[0];

    const videoUrl = reel.videoUrl || reel.displayUrl;
    const caption = reel.caption || '';
    const owner = reel.ownerUsername || 'unknown';
    console.log('[APIFY] videoUrl:', videoUrl ? 'YES' : 'none', 'caption:', caption.length);

    // Step 4: Whisper transcription
    if (videoUrl && groqKey) {
      try {
        console.log('[APIFY] Downloading video...');
        const vResp = await fetch(videoUrl, { signal: AbortSignal.timeout(15000) });
        const buf = Buffer.from(await vResp.arrayBuffer());
        console.log('[APIFY] Video:', buf.length, 'bytes');

        if (buf.length > 100 && buf.length < 25_000_000) {
          const FormData = (await import('form-data')).default;
          const fd = new FormData();
          fd.append('file', buf, { filename: 'r.mp4', contentType: 'video/mp4' });
          fd.append('model', 'whisper-large-v3');

          const wResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + groqKey, ...fd.getHeaders() },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            body: fd as any,
            signal: AbortSignal.timeout(30000),
          });

          if (wResp.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const r = await wResp.json() as any;
            console.log('[APIFY] Whisper:', r.text?.length || 0, 'chars');
            if (r.text && r.text.length > 20) {
              return { title: 'Instagram @' + owner + ' (audio)', text: r.text, sourceType: 'instagram' };
            }
          } else {
            console.log('[APIFY] Whisper fail:', wResp.status);
          }
        }
      } catch (e) {
        console.log('[APIFY] Video err:', e instanceof Error ? e.message : String(e));
      }
    }

    if (caption.length > 50) {
      return { title: 'Instagram @' + owner, text: caption, sourceType: 'instagram' };
    }
    return null;
  } catch (e) {
    console.log('[APIFY] Error:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
