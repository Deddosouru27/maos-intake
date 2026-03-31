export async function fetchInstagramTranscript(url: string): Promise<{ title: string; text: string } | null> {
  const apifyToken = process.env.APIFY_API_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;

  console.log('[APIFY] Starting Instagram pipeline for:', url);
  console.log('[APIFY] APIFY_API_TOKEN:', apifyToken ? 'SET' : 'MISSING');
  console.log('[APIFY] GROQ_API_KEY:', groqKey ? 'SET' : 'MISSING');

  if (!apifyToken) return null;

  // Step 1: Apify downloads video URL
  const { ApifyClient } = await import('apify-client');
  const client = new ApifyClient({ token: apifyToken });

  let run;
  try {
    run = await client.actor('bytepulselabs/instagram-video-downloader').call(
      { urls: [url] },
      { timeout: 30 },
    );
  } catch (e) {
    console.log('[APIFY] Error:', e instanceof Error ? e.message : String(e));
    return null;
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log('[APIFY] Actor result items:', items.length);
  if (!items.length) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const item = items[0] as any;
  const videoUrl = item.videoUrl || item.downloadUrl;
  const caption = item.caption || '';

  console.log('[APIFY] videoUrl:', videoUrl || 'none');
  console.log('[APIFY] caption length:', caption?.length || 0);

  if (!videoUrl) {
    return caption.length > 20 ? { title: 'Instagram Reel', text: caption } : null;
  }

  // Step 2: Download video
  let videoBuffer: Buffer;
  try {
    const videoResp = await fetch(videoUrl, { signal: AbortSignal.timeout(20000) });
    if (!videoResp.ok) throw new Error(`Video fetch ${videoResp.status}`);
    videoBuffer = Buffer.from(await videoResp.arrayBuffer());
    console.log('[APIFY] Video downloaded:', videoBuffer.length, 'bytes');
  } catch (e) {
    console.log('[APIFY] Error:', e instanceof Error ? e.message : String(e));
    return caption.length > 20 ? { title: 'Instagram Reel', text: caption } : null;
  }

  // Step 3: Groq Whisper transcription
  if (groqKey && videoBuffer.length < 25_000_000) {
    try {
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('file', videoBuffer, { filename: 'reel.mp4', contentType: 'video/mp4' });
      formData.append('model', 'whisper-large-v3');
      formData.append('language', 'ru');

      const whisperResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + groqKey,
          ...formData.getHeaders(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: formData as any,
      });

      if (whisperResp.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await whisperResp.json() as any;
        console.log('[APIFY] Whisper result:', result?.text?.length || 0, 'chars');
        if (result.text && result.text.length > 20) {
          return { title: 'Instagram Reel (audio)', text: result.text };
        }
      } else {
        console.log('[APIFY] Error:', whisperResp.status, await whisperResp.text());
      }
    } catch (e) {
      console.log('[APIFY] Error:', e instanceof Error ? e.message : String(e));
    }
  }

  // Fallback: caption
  return caption.length > 20 ? { title: 'Instagram Reel', text: caption } : null;
}
