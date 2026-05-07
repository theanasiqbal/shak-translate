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
  constructor(inputLang, outputLang) {
    this.inputLang = inputLang;
    this.outputLang = outputLang;
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
  }

  _buildConfig() {
    return {
      model: 'gemini-live-2.5-flash-native-audio',
      config: {
        systemInstruction: {
          parts: [{
            text: `You are a professional interpreter. The user will provide spoken audio in ${this.inputLang}. \nYou must translate it into ${this.outputLang}. Provide the spoken translation using your native audio voice.`
          }]
        },
        responseModalities: ['AUDIO'],
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

      // Collect raw PCM audio chunks from the model
      if (msg.serverContent && msg.serverContent.modelTurn) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.inlineData) {
            this.audioBuffers.push(Buffer.from(part.inlineData.data, 'base64'));
          }
        }
      }

      // Capture the model's spoken translation text
      if (msg.serverContent && msg.serverContent.outputTranscription) {
        if (msg.serverContent.outputTranscription.text) {
          this.fullTranslationText += msg.serverContent.outputTranscription.text;
        }
      }

      // Capture the user's original speech text
      if (msg.serverContent && msg.serverContent.inputTranscription) {
        if (msg.serverContent.inputTranscription.text) {
          this.fullOriginalText += msg.serverContent.inputTranscription.text;
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        // Wrap all PCM chunks into a single WAV and fire the callback
        if (this.audioBuffers.length > 0 && this.currentOnAudioChunk) {
          const combinedPcm = Buffer.concat(this.audioBuffers);
          const wavBuffer = wrapPcmInWav(combinedPcm, 24000);
          this.currentOnAudioChunk({
            audioBase64: wavBuffer.toString('base64'),
            index: 0,
            text: this.fullTranslationText.trim()
          });
        }

        if (this.currentResolve) {
          this.currentResolve({
            originalText: this.fullOriginalText.trim(),
            translatedText: this.fullTranslationText.trim(),
            totalChunks: this.audioBuffers.length > 0 ? 1 : 0
          });
        }

        // Reset per-turn state (session stays open for the next turn)
        this._resetTurnState();
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
      this.currentResolve = resolve;
      this.currentReject = reject;
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
async function warmupSession(sessionId, role, inputLang, outputLang) {
  const key = `${sessionId}:${role}`;
  if (activeSessions.has(key)) return; // Already warmed up

  const liveSession = new LiveTranslationSession(inputLang, outputLang);
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
async function processAudioChunk(sessionId, role, audioBase64, mimeType, inputLang, outputLang, onAudioChunk) {
  const key = `${sessionId}:${role}`;

  if (!activeSessions.has(key)) {
    // Cold path: session wasn't pre-warmed (e.g. after a reconnect)
    const liveSession = new LiveTranslationSession(inputLang, outputLang);
    activeSessions.set(key, liveSession);
  }

  const liveSession = activeSessions.get(key);
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