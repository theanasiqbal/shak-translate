require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load GCP service account credentials from env var (for Render deployment).
// Set GOOGLE_APPLICATION_CREDENTIALS_JSON to the full JSON contents of your key file.
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const credPath = path.join(os.tmpdir(), 'gcp-credentials.json');
    fs.writeFileSync(credPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    console.log('[geminiService] GCP credentials loaded from env var.');
  } catch (err) {
    console.error('[geminiService] Failed to write GCP credentials:', err.message);
  }
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

if (!project) {
  console.error('[geminiService] GOOGLE_CLOUD_PROJECT is not set!');
  process.exit(1);
}

const ai = new GoogleGenAI({
  vertexai: true,
  project,
  location,
});

/**
 * Wraps raw PCM data in a WAV header so the frontend can play it easily.
 * Gemini Native Audio outputs 16-bit PCM at 24000 Hz.
 */
function wrapPcmInWav(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM data
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

/**
 * A persistent Gemini Live session for a specific translation direction.
 * Handles automatic reconnection if the connection drops.
 */
class LiveTranslationSession {
  constructor(inputLang, outputLang, voiceProfile = {}) {
    this.inputLang = inputLang;
    this.outputLang = outputLang;
    this.voiceProfile = voiceProfile; // { gender?: string, age?: number }
    this.session = null;
    this.isConnecting = false;
    this.connectPromise = null;

    // State for the current in-flight translation turn
    this.audioBuffers = [];
    this.fullTranslationText = '';
    this.fullOriginalText = '';
    this.currentResolve = null;
    this.currentReject = null;
    this.currentOnAudioChunk = null;
    this.audioChunkIndex = 0;
  }


  _buildVoiceName() {
    const { gender } = this.voiceProfile;
    // Gemini Live API prebuilt voices:
    // Female: 'Aoede', 'Kore'
    // Male: 'Puck', 'Charon', 'Fenrir'
    // Neutral: 'Orbit'
    if (gender === 'male') return 'Puck';
    if (gender === 'female') return 'Aoede';
    return 'Aoede'; // neutral fallback
  }

  _buildConfig() {
    const voiceName = this._buildVoiceName();

    return {
      model: 'gemini-live-2.5-flash-native-audio',
      config: {
        systemInstruction: {
          parts: [{
            text: `You are a dedicated translator. Your ONLY task is to translate spoken audio from ${this.inputLang} into ${this.outputLang}. Translate naturally and idiomatically, preserving the true conversational meaning and intent rather than providing a literal word-for-word translation. Do NOT respond to the content of the message, do NOT answer questions, and do NOT engage in conversation. ONLY provide the translation. If the user asks a question, translate that question into ${this.outputLang} without answering it. Output ONLY the translated speech. CRITICAL: Do NOT repeat previous translations. ONLY translate the new audio clip provided in the current turn. Ignore any background noise, static, breathing, coughing, or unintelligible sounds. If the audio clip contains only noise and no clear speech, output absolutely nothing.`
          }]
        },
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName
            }
          }
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (data) => this._onMessage(data),
        onerror: (err) => this._onError(err),
        onclose: (e) => this._onClose(e),
      }
    };
  }

  _onMessage(data) {
    try {
      const msg = typeof data === 'string' || Buffer.isBuffer(data)
        ? JSON.parse(data.toString())
        : data;

      // Collect raw PCM audio and text from the model's turn
      if (msg.serverContent && msg.serverContent.modelTurn) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.text) {
            this.fullTranslationText += part.text;
          }
          if (part.inlineData) {
            const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
            this.audioBuffers.push(pcmBuffer);
          }
        }
      }

      // Capture the model's spoken translation text (outputTranscription)
      if (msg.serverContent && msg.serverContent.outputTranscription) {
        if (msg.serverContent.outputTranscription.text) {
          this.fullTranslationText += msg.serverContent.outputTranscription.text;
        }
      }

      // Capture the user's original speech text (inputTranscription)
      if (msg.serverContent && msg.serverContent.inputTranscription) {
        if (msg.serverContent.inputTranscription.text) {
          this.fullOriginalText += msg.serverContent.inputTranscription.text;
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        // Build the combined translated WAV once so we can both stream it and save it
        let translatedAudioBase64 = null;
        if (this.audioBuffers.length > 0) {
          const combinedPcm = Buffer.concat(this.audioBuffers);
          translatedAudioBase64 = wrapPcmInWav(combinedPcm, 24000).toString('base64');
        }

        // Send the entire accumulated sentence as one complete audio chunk
        if (this.currentOnAudioChunk && translatedAudioBase64) {
          this.currentOnAudioChunk({
            audioBase64: translatedAudioBase64,
            index: 0,
            text: this.fullTranslationText.trim()
          });
        }

        if (this.currentResolve) {
          this.currentResolve({
            originalText: this.fullOriginalText.trim(),
            translatedText: this.fullTranslationText.trim(),
            totalChunks: 1,
            translatedAudioBase64, // ← used by server.js to save to Supabase Storage
          });
        }

        // Reset per-turn state
        this._resetTurnState();

        // Signal to geminiService to completely destroy this session instance
        if (this.onTurnCompleteCallback) {
          this.onTurnCompleteCallback();
        }
      }
    } catch (err) {
      if (this.currentReject) {
        this.currentReject(err);
        this._resetTurnState();
      }
    }
  }

  _onError(err) {
    console.error('[LiveTranslationSession] Live session error:', err);
    if (this.currentReject) {
      this.currentReject(err);
      this._resetTurnState();
    }
    this.session = null; // Force reconnect next time
  }

  _onClose(e) {
    console.log(`[LiveTranslationSession] Session closed (${this.inputLang}→${this.outputLang}):`, e?.code, e?.reason);
    if (e && e.code && e.code !== 1000 && this.currentReject) {
      this.currentReject(new Error(`Live session closed with code ${e.code}: ${e.reason || 'Unknown error'}`));
      this._resetTurnState();
    }
    this.session = null; // Will reconnect on next use
  }

  _resetTurnState() {
    this.audioBuffers = [];
    this.fullTranslationText = '';
    this.fullOriginalText = '';
    this.currentResolve = null;
    this.currentReject = null;
    this.currentOnAudioChunk = null;
    this.audioChunkIndex = 0;
  }

  setTurnCompleteCallback(cb) {
    this.onTurnCompleteCallback = cb;
  }

  /**
   * Ensure the Live API connection is open and ready.
   * If already connected, returns immediately.
   * If connecting, waits for the in-flight connect to finish.
   */
  async ensureConnected() {
    if (this.session) return; // Already connected

    if (this.connectPromise) {
      await this.connectPromise; // Wait for an in-flight connect
      return;
    }

    console.log(`[LiveTranslationSession] Opening session (${this.inputLang}→${this.outputLang})...`);
    this.connectPromise = ai.live.connect(this._buildConfig())
      .then((session) => {
        this.session = session;
        this.connectPromise = null;
        console.log(`[LiveTranslationSession] Session ready (${this.inputLang}→${this.outputLang})`);
      })
      .catch((err) => {
        this.connectPromise = null;
        throw err;
      });

    await this.connectPromise;
  }

  /**
   * Send one audio chunk for translation and wait for the turn to complete.
   * The session stays open after this call.
   */
  async translate(audioBase64, mimeType, onAudioChunk) {
    await this.ensureConnected();

    return new Promise((resolve, reject) => {
      // 15 second timeout to prevent getting stuck in "TRANSLATING..." state
      const timeout = setTimeout(() => {
        if (this.currentReject) {
          console.warn(`[LiveTranslationSession] Timeout waiting for turnComplete (${this.inputLang}→${this.outputLang})`);
          this.currentReject(new Error("Gemini API timeout"));
          this._resetTurnState();
        }
      }, 15000);

      this.currentResolve = (res) => {
        clearTimeout(timeout);
        resolve(res);
      };
      this.currentReject = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
      this.currentOnAudioChunk = onAudioChunk;

      const clientMessage = {
        clientContent: {
          turns: [{
            role: 'user',
            parts: [{
              inlineData: {
                data: audioBase64,
                mimeType: mimeType
              }
            }]
          }],
          turnComplete: true
        }
      };

      if (this.session?.conn?.send) {
        this.session.conn.send(JSON.stringify(clientMessage));
      } else {
        reject(new Error('Unable to send message: Live API connection is not available.'));
        this._resetTurnState();
      }
    });
  }

  /**
   * Gracefully close the session and free resources.
   */
  close() {
    if (this.session?.conn?.close) {
      this.session.conn.close();
    }
    this.session = null;
  }
}

/**
 * Per-app-session cache of persistent Gemini Live connections.
 * Key: `${sessionId}:${role}` → LiveTranslationSession
 */
const activeSessions = new Map();

/**
 * Pre-warm a Live API session for a given translation direction.
 * Call this when a translation session is created/joined so the first
 * audio chunk hits an already-open connection.
 *
 * @param {string} sessionId   - App session ID
 * @param {string} role        - 'host' or 'guest'
 * @param {string} inputLang   - Speaker's language
 * @param {string} outputLang  - Listener's language
 */
async function warmupSession(sessionId, role, inputLang, outputLang, voiceProfile = {}) {
  const key = `${sessionId}:${role}`;
  if (activeSessions.has(key)) return; // Already warmed up

  const liveSession = new LiveTranslationSession(inputLang, outputLang, voiceProfile);
  activeSessions.set(key, liveSession);

  try {
    await liveSession.ensureConnected();
    console.log(`[geminiService] Warmed up session for ${role} in session ${sessionId}`);
  } catch (err) {
    console.error(`[geminiService] Warmup failed for ${role} in session ${sessionId}:`, err.message);
    activeSessions.delete(key); // Remove so it retries on first use
  }
}

/**
 * Transcribes, translates, and synthesises speech for one audio chunk.
 * Reuses an existing persistent Live API session if available;
 * falls back to creating a new one if the session was lost.
 *
 * @param {string}   sessionId    - App session ID (for connection reuse)
 * @param {string}   role         - 'host' or 'guest'
 * @param {string}   audioBase64  - Base64-encoded audio from the sender
 * @param {string}   mimeType     - MIME type (e.g. "audio/mp4")
 * @param {string}   inputLang    - Speaker's language name
 * @param {string}   outputLang   - Listener's language name
 * @param {Function} onAudioChunk - Callback when an audio chunk is ready
 * @returns {Promise<{ translatedText: string, originalText: string, totalChunks: number }>}
 */
async function processAudioChunk(sessionId, role, audioBase64, mimeType, inputLang, outputLang, voiceProfile, onAudioChunk) {
  const key = `${sessionId}:${role}`;

  if (activeSessions.has(key)) {
    const existing = activeSessions.get(key);
    // Warmup creates the Gemini session before gender/age are known.
    // On the first audio_chunk that carries a voice profile, rebuild
    // the session so the correct voice instruction is applied.
    const cachedGender = existing.voiceProfile && existing.voiceProfile.gender;
    const incomingGender = voiceProfile && voiceProfile.gender;
    if (!cachedGender && incomingGender) {
      console.log(`[geminiService] Voice profile for ${role}: gender=${incomingGender}, age=${voiceProfile.age} — rebuilding session.`);
      existing.close();
      activeSessions.delete(key);
    }
  }

  if (!activeSessions.has(key)) {
    // Cold path: not pre-warmed, or just rebuilt above for voice profile
    const liveSession = new LiveTranslationSession(inputLang, outputLang, voiceProfile || {});
    activeSessions.set(key, liveSession);
  }

  const liveSession = activeSessions.get(key);
  
  // Unconditionally attach the callback so that EVEN pre-warmed sessions get destroyed 
  // after their first turn, guaranteeing the chat history is wiped.
  liveSession.setTurnCompleteCallback(() => {
    liveSession.close();
    activeSessions.delete(key);
    
    // Eagerly pre-warm the next session so it's ready before the user speaks
    warmupSession(sessionId, role, inputLang, outputLang, voiceProfile).catch(() => {});
  });

  return liveSession.translate(audioBase64, mimeType, onAudioChunk);
}

/**
 * Tear down the persistent Gemini Live session for a given app session/role.
 * Call this when the app session ends.
 *
 * @param {string} sessionId
 * @param {string} role
 */
function closeSession(sessionId, role) {
  const key = `${sessionId}:${role}`;
  const liveSession = activeSessions.get(key);
  if (liveSession) {
    liveSession.close();
    activeSessions.delete(key);
    console.log(`[geminiService] Closed persistent session for ${role} in session ${sessionId}`);
  }
}

module.exports = { processAudioChunk, warmupSession, closeSession };