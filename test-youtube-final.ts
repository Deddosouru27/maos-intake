import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const url = 'https://www.youtube.com/watch?v=jKrQLHxOz_0';

async function test() {

  // TEST 1: gemini-3-flash-preview + SDK fileData
  try {
    const r1 = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: url, mimeType: 'video/*' } },
        { text: 'Summarize this video in 3 sentences.' }
      ]}]
    });
    console.log('TEST 1 (3-flash fileData):', r1.text?.slice(0, 200));
  } catch(e: any) { console.log('TEST 1 ERROR:', e.message?.slice(0, 200)); }

  // TEST 2: gemini-2.5-flash + SDK fileData (control)
  try {
    const r2 = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: url, mimeType: 'video/*' } },
        { text: 'Summarize this video in 3 sentences.' }
      ]}]
    });
    console.log('TEST 2 (2.5-flash fileData):', r2.text?.slice(0, 200));
  } catch(e: any) { console.log('TEST 2 ERROR:', e.message?.slice(0, 200)); }

  // TEST 3: URL as plain text (no fileData)
  try {
    const r3 = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts: [
        { text: `Watch this YouTube video and summarize it: ${url}` }
      ]}]
    });
    console.log('TEST 3 (3-flash URL as text):', r3.text?.slice(0, 200));
  } catch(e: any) { console.log('TEST 3 ERROR:', e.message?.slice(0, 200)); }

  // TEST 4: v1alpha API version
  const aiAlpha = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    apiVersion: 'v1alpha'
  });
  try {
    const r4 = await aiAlpha.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: url, mimeType: 'video/*' } },
        { text: 'Summarize this video in 3 sentences.' }
      ]}]
    });
    console.log('TEST 4 (v1alpha + 3-flash):', r4.text?.slice(0, 200));
  } catch(e: any) { console.log('TEST 4 ERROR:', e.message?.slice(0, 200)); }
}

test();
