import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { fileData: { fileUri: 'https://www.youtube.com/watch?v=jKrQLHxOz_0', mimeType: 'video/*' } },
          { text: 'Summarize this video in 3 sentences. Return JSON: {"summary":"...","relevant":true}' }
        ]
      }]
    });
    console.log('SUCCESS:', response.text);
  } catch(e: any) {
    console.log('ERROR gemini-2.5-flash:', e.message);

    // Если gemini-2.5-flash не работает — попробовать gemini-3-flash-preview
    try {
      const response2 = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{
          role: 'user',
          parts: [
            { fileData: { fileUri: 'https://www.youtube.com/watch?v=jKrQLHxOz_0', mimeType: 'video/*' } },
            { text: 'Summarize this video in 3 sentences.' }
          ]
        }]
      });
      console.log('SUCCESS with 3-flash:', response2.text);
    } catch(e2: any) {
      console.log('ERROR 3-flash:', e2.message);
    }
  }
}

test();
