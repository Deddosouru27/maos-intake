export async function fetchInstagramTranscript(url: string): Promise<{ title: string; text: string; sourceType: string } | null> {
  const apifyToken = process.env.APIFY_API_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;
  if (!apifyToken) {
    console.log('[APIFY] APIFY_API_TOKEN MISSING');
    return null;
  }

  try {
    console.log('[APIFY] Starting for:', url);
    const { ApifyClient } = await import('apify-client');
    const client = new ApifyClient({ token: apifyToken });

    // Step 1: Get reel metadata quickly (includes videoUrl)
    const run = await client.actor('apify/instagram-reel-scraper').call(
      { directUrls: [url], resultsLimit: 1 },
      { timeout: 45 },
    );

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.log('[APIFY] Items:', items.length);

    if (!items.length) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reel = items[0] as any;

    const videoUrl = reel.videoUrl || reel.displayUrl;
    const caption = reel.caption || '';
    const owner = reel.ownerUsername || 'unknown';

    console.log('[APIFY] videoUrl:', videoUrl ? 'YES' : 'none');
    console.log('[APIFY] caption:', caption.length, 'chars');

    // Step 2: If video URL and Groq available — transcribe
    if (videoUrl && groqKey) {
      try {
        console.log('[APIFY] Downloading video...');
        const resp = await fetch(videoUrl, { signal: AbortSignal.timeout(15000) });
        const buffer = Buffer.from(await resp.arrayBuffer());
        console.log('[APIFY] Video size:', buffer.length, 'bytes');

        if (buffer.length > 0 && buffer.length < 25_000_000) {
          const FormData = (await import('form-data')).default;
          const fd = new FormData();
          fd.append('file', buffer, { filename: 'reel.mp4', contentType: 'video/mp4' });
          fd.append('model', 'whisper-large-v3');

          console.log('[APIFY] Calling Groq Whisper...');
          const whisperResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + groqKey, ...fd.getHeaders() },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            body: fd as any,
            signal: AbortSignal.timeout(30000),
          });

          if (whisperResp.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await whisperResp.json() as any;
            console.log('[APIFY] Whisper transcript:', result.text?.length || 0, 'chars');
            if (result.text && result.text.length > 20) {
              return {
                title: 'Instagram @' + owner + ' (audio)',
                text: result.text,
                sourceType: 'instagram',
              };
            }
          } else {
            console.log('[APIFY] Whisper error:', whisperResp.status);
          }
        }
      } catch (e) {
        console.log('[APIFY] Video/Whisper error:', e instanceof Error ? e.message : String(e));
      }
    }

    // Fallback: caption
    if (caption.length > 50) {
      return { title: 'Instagram @' + owner, text: caption, sourceType: 'instagram' };
    }

    return null;
  } catch (e) {
    console.log('[APIFY] Error:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
