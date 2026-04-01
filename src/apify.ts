// Нативный fetch, никаких SDK, максимум логов

const APIFY_BASE = 'https://api.apify.com/v2';

export async function fetchInstagramTranscript(
  url: string,
): Promise<{ title: string; text: string; sourceType: string } | null> {
  const token = process.env.APIFY_API_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;

  console.log('[APIFY] === Instagram pipeline START ===');
  console.log('[APIFY] URL:', url);
  console.log('[APIFY] APIFY_API_TOKEN:', token ? `SET (${token.substring(0, 12)}...)` : 'MISSING');
  console.log('[APIFY] GROQ_API_KEY:', groqKey ? 'SET' : 'MISSING');

  if (!token) {
    console.log('[APIFY] ABORT: no token');
    return null;
  }

  try {
    // Step 1: Start actor
    console.log('[APIFY] Step 1: Starting actor apify/instagram-reel-scraper...');
    const startResp = await fetch(
      `${APIFY_BASE}/acts/apify~instagram-scraper/runs?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directUrls: [url], resultsLimit: 1, resultsType: 'posts' }),
        signal: AbortSignal.timeout(15000),
      },
    );

    console.log('[APIFY] Actor start response:', startResp.status, startResp.statusText);

    if (!startResp.ok) {
      const errText = await startResp.text();
      console.log('[APIFY] Actor start FAILED:', errText.substring(0, 500));
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runData = (await startResp.json()) as any;
    const runId = runData?.data?.id;
    const datasetId = runData?.data?.defaultDatasetId;
    console.log('[APIFY] Run ID:', runId);
    console.log('[APIFY] Run status:', runData?.data?.status);

    if (!runId) {
      console.log('[APIFY] No run ID returned');
      return null;
    }

    // Step 2: Poll for completion (every 3s, max 39s)
    console.log('[APIFY] Step 2: Polling for completion...');
    let status = runData?.data?.status;
    let attempts = 0;
    const maxAttempts = 13;

    while (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'ABORTED' && attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 3000));
      attempts++;
      const pollResp = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`, {
        signal: AbortSignal.timeout(10000),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pollData = (await pollResp.json()) as any;
      status = pollData?.data?.status;
      console.log(`[APIFY] Poll ${attempts}/${maxAttempts}: ${status}`);
    }

    if (status !== 'SUCCEEDED') {
      console.log('[APIFY] Run did not succeed:', status);
      return null;
    }

    // Step 3: Fetch dataset results
    console.log('[APIFY] Step 3: Fetching dataset:', datasetId);
    const dsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${token}`, {
      signal: AbortSignal.timeout(10000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (await dsResp.json()) as any[];
    console.log('[APIFY] Dataset items:', items?.length || 0);

    if (!items || items.length === 0) {
      console.log('[APIFY] No items in dataset');
      return null;
    }

    const reel = items[0];
    const videoUrl = reel.videoUrl || reel.displayUrl;
    const caption = reel.caption || '';
    const owner = reel.ownerUsername || 'unknown';

    console.log('[APIFY] videoUrl:', videoUrl ? videoUrl.substring(0, 80) + '...' : 'none');
    console.log('[APIFY] caption:', caption.length, 'chars');
    console.log('[APIFY] owner:', owner);

    // Step 4: Download video + Groq Whisper
    if (videoUrl && groqKey) {
      try {
        console.log('[APIFY] Step 4: Downloading video...');
        const vidResp = await fetch(videoUrl, { signal: AbortSignal.timeout(15000) });

        if (!vidResp.ok) {
          console.log('[APIFY] Video download failed:', vidResp.status);
        } else {
          const buffer = Buffer.from(await vidResp.arrayBuffer());
          console.log('[APIFY] Video size:', buffer.length, 'bytes');

          if (buffer.length > 100 && buffer.length < 25_000_000) {
            console.log('[APIFY] Step 5: Calling Groq Whisper...');

            // Build multipart form-data manually (no form-data package needed)
            const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
            const parts: Buffer[] = [];

            parts.push(Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reel.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
            ));
            parts.push(buffer);
            parts.push(Buffer.from('\r\n'));
            parts.push(Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`,
            ));
            parts.push(Buffer.from(`--${boundary}--\r\n`));

            const body = Buffer.concat(parts);

            const whisperResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + groqKey,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
              },
              body,
              signal: AbortSignal.timeout(30000),
            });

            console.log('[APIFY] Whisper response:', whisperResp.status);

            if (whisperResp.ok) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const result = (await whisperResp.json()) as any;
              console.log('[APIFY] Transcript length:', result.text?.length || 0, 'chars');

              if (result.text && result.text.length > 20) {
                console.log('[APIFY] === SUCCESS: Audio transcript ===');
                return {
                  title: `Instagram @${owner} (audio)`,
                  text: result.text,
                  sourceType: 'instagram',
                };
              }
            } else {
              const errText = await whisperResp.text();
              console.log('[APIFY] Whisper error:', errText.substring(0, 300));
            }
          }
        }
      } catch (e) {
        console.log('[APIFY] Video/Whisper error:', e instanceof Error ? e.message : String(e));
      }
    }

    // Fallback: caption
    if (caption.length > 50) {
      console.log('[APIFY] === FALLBACK: caption ===');
      return { title: `Instagram @${owner}`, text: caption, sourceType: 'instagram' };
    }

    console.log('[APIFY] === FAIL: no useful content ===');
    return null;
  } catch (e) {
    console.log('[APIFY] === FATAL ERROR ===', e instanceof Error ? e.message : String(e));
    return null;
  }
}
