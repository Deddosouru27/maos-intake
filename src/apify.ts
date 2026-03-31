export async function fetchInstagramTranscript(url: string): Promise<{ title: string; text: string } | null> {
  const apifyToken = process.env.APIFY_API_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;
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
    console.log('[INTAKE] Apify Instagram actor failed:', e instanceof Error ? e.message : String(e));
    return null;
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items.length) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const item = items[0] as any;
  const videoUrl = item.videoUrl || item.downloadUrl;
  const caption = item.caption || '';

  if (!videoUrl) {
    return caption.length > 20 ? { title: 'Instagram Reel', text: caption } : null;
  }

  // Step 2: Download video
  let videoBuffer: Buffer;
  try {
    const videoResp = await fetch(videoUrl, { signal: AbortSignal.timeout(20000) });
    if (!videoResp.ok) throw new Error(`Video fetch ${videoResp.status}`);
    videoBuffer = Buffer.from(await videoResp.arrayBuffer());
  } catch (e) {
    console.log('[INTAKE] Instagram video download failed:', e instanceof Error ? e.message : String(e));
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
        if (result.text && result.text.length > 20) {
          console.log('[INTAKE] Groq Whisper Instagram OK:', result.text.length, 'chars');
          return { title: 'Instagram Reel (audio)', text: result.text };
        }
      } else {
        console.log('[INTAKE] Groq Whisper failed:', whisperResp.status, await whisperResp.text());
      }
    } catch (e) {
      console.log('[INTAKE] Groq Whisper error:', e instanceof Error ? e.message : String(e));
    }
  }

  // Fallback: caption
  return caption.length > 20 ? { title: 'Instagram Reel', text: caption } : null;
}
