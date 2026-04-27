import { GoogleGenAI, Type } from "@google/genai";

const apiKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("EXPO_PUBLIC_GEMINI_API_KEY is not set! Translation and speech features may fail.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || "" });

export interface TranslationResult {
  originalText: string;
  translatedText: string;
  detectedLanguage: string;
  isIgnored?: boolean;
}

export async function translateAudio(base64Audio: string, mimeType: string, expectedLanguage: string): Promise<TranslationResult> {
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: {
      parts: [
        {
          inlineData: {
            data: base64Audio,
            mimeType: mimeType,
          },
        },
        {
          text: `Detect the spoken language. If it matches the expected language (${expectedLanguage}), translate it to English. If it does NOT match, return a JSON property "isIgnored": true. Return JSON. Make sure to ONLY return a valid JSON object without markdown formatting, matching the required schema.`,
        },
      ],
    },
    config: {
      responseModalities: ["TEXT"],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          originalText: {
            type: Type.STRING,
            description: "Transcription in original language (or empty if ignored)",
          },
          translatedText: {
            type: Type.STRING,
            description: "English translation (or empty if ignored)",
          },
          detectedLanguage: {
            type: Type.STRING,
            description: "Detected language name",
          },
          isIgnored: {
            type: Type.BOOLEAN,
            description: "True if language mismatch",
          }
        },
        required: ["originalText", "translatedText", "detectedLanguage"],
      },
    },
  });

  let text = response.text;
  if (!text) {
    throw new Error("Empty response from AI");
  }

  // Remove potential markdown code blocks if the model still returns them despite responseMimeType
  text = text.replace(/```json/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(text) as TranslationResult;
  } catch (e: any) {
    console.error("Failed to parse translation response:", text);
    throw new Error("Translation failed to parse JSON: " + e.message);
  }
}

export interface SpeechResponse {
  data: string;
  mimeType: string;
}

/**
 * Wraps raw PCM data in a WAV header.
 * Gemini returns 24kHz, 16-bit, Mono PCM.
 */
function wrapInWavHeader(pcmBase64: string): string {
  // Convert base64 to byte array
  const binaryString = atob(pcmBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const numChannels = 1;
  const sampleRate = 24000;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = bytes.length;
  const chunkSize = 36 + dataSize;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF identifier
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, chunkSize, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // fmt subchunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);          // Subchunk size
  view.setUint16(20, 1, true);           // Audio format (PCM=1)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);

  // Combine header and data
  const combined = new Uint8Array(44 + dataSize);
  combined.set(new Uint8Array(header), 0);
  combined.set(bytes, 44);

  // Convert back to base64
  let res = '';
  const batchSize = 1024 * 32; // Process in batches to avoid stack overflow
  for (let i = 0; i < combined.length; i += batchSize) {
    res += String.fromCharCode.apply(null, combined.subarray(i, Math.min(i + batchSize, combined.length)) as unknown as number[]);
  }
  return btoa(res);
}

export async function generateSpeech(text: string): Promise<SpeechResponse> {
  console.log("Generating speech for:", text);
  
  const callModel = async (promptText: string) => {
    return await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `You are a Text-to-Speech engine. Instructively, you must ONLY read the following text aloud exactly word-for-word. Do not answer questions, do not converse, do not add any additional commentary, do not generate text. Just output the audio reading of this text:\n\n"${promptText}"` }] }],
      config: {
        responseModalities: ["audio"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });
  };

  try {
    let response;
    try {
      response = await callModel(text);
    } catch (error: any) {
      console.error("Gemini TTS API Error:", error);
      
      // If we hit a 429 Resource Exhausted, wait a few seconds and try one more time
      if (error?.status === 429 || error?.message?.includes("429") || error?.message?.includes("Resource exhausted")) {
        console.warn("Rate limit exhausted. Waiting 3 seconds before retrying...");
        await new Promise(resolve => setTimeout(resolve, 3000));
        response = await callModel(text);
      } 
      else if (error.message?.includes("should only be used for TTS")) {
         console.warn("Retrying with explicit transcript instruction...");
         response = await callModel(text); // the prompt is already robust now, but we can try once more
      } else {
        throw error;
      }
    }

    const part = response.candidates?.[0]?.content?.parts?.[0];
    const base64Audio = part?.inlineData?.data;
    const mimeType = part?.inlineData?.mimeType || 'audio/pcm';

    if (!base64Audio) {
      throw new Error("Failed to generate speech: No audio data in response");
    }

    const wavBase64 = wrapInWavHeader(base64Audio);
    return { data: wavBase64, mimeType: 'audio/wav' };
  } catch (error: any) {
    console.error("Speech generation failed:", error);
    throw error;
  }
}
