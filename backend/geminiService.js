require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set in .env!');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

/**
 * Wraps raw PCM data (24kHz, 16-bit, mono) in a WAV header.
 * Returns base64-encoded WAV.
 */
function wrapInWavHeader(pcmBase64) {
  const binaryString = Buffer.from(pcmBase64, 'base64');
  const dataSize = binaryString.length;

  const numChannels = 1;
  const sampleRate = 24000;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);       // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);        // AudioFormat (PCM = 1)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const combined = Buffer.concat([header, binaryString]);
  return combined.toString('base64');
}

/**
 * Transcribes, translates, and synthesises speech for one audio chunk.
 * @param {string} audioBase64   - Base64-encoded audio from the sender
 * @param {string} mimeType      - MIME type of the audio (e.g. "audio/mp4")
 * @param {string} inputLang     - Speaker's language name (e.g. "Mandarin")
 * @param {string} outputLang    - Listener's language name (e.g. "English")
 * @returns {{ translatedText: string, audioBase64: string, originalText: string }}
 */
async function processAudioChunk(audioBase64, mimeType, inputLang, outputLang) {
  // ── Step 1: Transcribe + Translate ──────────────────────────────────────────
  const translationResponse = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: {
      parts: [
        {
          inlineData: {
            data: audioBase64,
            mimeType: mimeType,
          },
        },
        {
          text: `You are a professional interpreter. The spoken audio is in ${inputLang}. 
Transcribe it exactly, then translate it into ${outputLang}. 
Return ONLY a valid JSON object (no markdown, no extra text) with these keys:
- "originalText": the exact transcription in ${inputLang}
- "translatedText": the translation in ${outputLang}
- "detectedLanguage": the detected language name

If the audio contains no intelligible speech, return { "originalText": "", "translatedText": "", "detectedLanguage": "${inputLang}", "isEmpty": true }.`,
        },
      ],
    },
    config: {
      responseModalities: ['TEXT'],
      responseMimeType: 'application/json',
    },
  });

  let translationText = translationResponse.text || '{}';
  // Strip any accidental markdown fences
  translationText = translationText.replace(/```json/g, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(translationText);
  } catch (e) {
    console.error('[geminiService] Failed to parse translation JSON:', translationText);
    throw new Error('Translation JSON parse failed: ' + e.message);
  }

  if (parsed.isEmpty || !parsed.translatedText) {
    return { originalText: '', translatedText: '', audioBase64: null };
  }

  // ── Step 2: Text-to-Speech ───────────────────────────────────────────────────
  const ttsResponse = await ai.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [
      {
        parts: [
          {
            text: `You are a Text-to-Speech engine. Read the following text aloud exactly, word-for-word, in ${outputLang}. Do not add any commentary.\n\n"${parsed.translatedText}"`,
          },
        ],
      },
    ],
    config: {
      responseModalities: ['audio'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  });

  const part = ttsResponse.candidates?.[0]?.content?.parts?.[0];
  const rawPcmBase64 = part?.inlineData?.data;

  if (!rawPcmBase64) {
    throw new Error('TTS returned no audio data');
  }

  const wavBase64 = wrapInWavHeader(rawPcmBase64);

  return {
    originalText: parsed.originalText || '',
    translatedText: parsed.translatedText,
    audioBase64: wavBase64,
  };
}

module.exports = { processAudioChunk };
