require('dotenv').config();
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { processAudioChunk, warmupSession, closeSession } = require('./geminiService');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

/**
 * ARCHITECTURE: "Audio-First" floor control
 *
 * partner_speaking is ONLY sent when real audio_chunk arrives at the server.
 * VAD claim_turn messages are completely ignored — they were the source of
 * all false "Partner is Speaking" states (noise, leakage, ringtones).
 *
 * Flow:
 *  1. Device A speaks → VAD detects → silence → stopRecording → sendAudioChunk
 *  2. Server receives audio_chunk → sends partner_speaking to B (real signal)
 *  3. Server processes → sends results to B, lock_released to B
 *  4. B clears partnerSpeaking → resumes recording
 */

const sessions = new Map();

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function getPartnerSocket(session, role) {
  return role === 'host' ? session.guest : session.host;
}

function cleanupSession(sessionId, disconnectedRole) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const partnerSocket = getPartnerSocket(session, disconnectedRole);
  send(partnerSocket, {
    type: 'partner_disconnected',
    message: `${disconnectedRole === 'host' ? 'Host' : 'Guest'} has disconnected.`,
  });

  if (partnerSocket && partnerSocket.readyState === partnerSocket.OPEN) {
    partnerSocket.close();
  }

  closeSession(sessionId, 'host');
  closeSession(sessionId, 'guest');
  sessions.delete(sessionId);
  console.log(`[server] Session ${sessionId} cleaned up (${disconnectedRole} disconnected).`);
}

wss.on('connection', (ws) => {
  console.log('[server] New WebSocket connection');

  let currentSessionId = null;
  let currentRole = null;

  ws.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (e) {
      send(ws, { type: 'error', message: 'Invalid JSON message.' });
      return;
    }

    const { type } = message;

    // ── CREATE SESSION (Host) ────────────────────────────────────────────────
    if (type === 'create_session') {
      const { lang } = message;
      const sessionId = uuidv4();
      sessions.set(sessionId, {
        host: ws, hostLang: lang,
        guest: null, guestLang: null,
        isProcessing: false,
      });
      currentSessionId = sessionId;
      currentRole = 'host';
      console.log(`[server] Session created: ${sessionId} (Host lang: ${lang})`);
      send(ws, { type: 'session_created', sessionId });
      return;
    }

    // ── JOIN SESSION (Guest) ─────────────────────────────────────────────────
    if (type === 'join_session') {
      const { sessionId, lang } = message;
      const session = sessions.get(sessionId);

      if (!session) {
        send(ws, { type: 'error', message: `Session "${sessionId}" not found.` });
        return;
      }
      if (session.guest) {
        send(ws, { type: 'error', message: `Session "${sessionId}" already has a guest.` });
        return;
      }

      session.guest = ws;
      session.guestLang = lang;
      currentSessionId = sessionId;
      currentRole = 'guest';
      console.log(`[server] Guest joined session: ${sessionId} (Guest lang: ${lang})`);

      send(session.host,  { type: 'session_ready', role: 'host',  sessionId, partnerLang: session.guestLang });
      send(session.guest, { type: 'session_ready', role: 'guest', sessionId, partnerLang: session.hostLang  });

      warmupSession(sessionId, 'host',  session.hostLang,  session.guestLang).catch(console.error);
      warmupSession(sessionId, 'guest', session.guestLang, session.hostLang).catch(console.error);
      return;
    }

    // ── FLOOR CONTROL (ignored — VAD events are unreliable) ─────────────────
    // claim_turn and release_turn are sent by the client but intentionally
    // ignored here. Floor control is handled implicitly via audio_chunk.
    if (type === 'claim_turn' || type === 'release_turn') {
      return;
    }

    // ── AUDIO CHUNK ──────────────────────────────────────────────────────────
    if (type === 'audio_chunk') {
      const { sessionId, role, audioBase64, mimeType, inputLang, outputLang } = message;
      const session = sessions.get(sessionId);

      if (!session) {
        send(ws, { type: 'error', message: 'Session not found.' });
        return;
      }
      if (!session.host || !session.guest) {
        send(ws, { type: 'error', message: 'Session not fully connected yet.' });
        return;
      }

      // If already processing, discard silently (prevents overlap)
      // The client will naturally send the next chunk after the current one plays.
      if (session.isProcessing) {
        console.log(`[server] Session ${sessionId} busy — discarding ${role} chunk`);
        send(ws, { type: 'processing_done' }); // unblock sender's isProcessing state
        return;
      }

      session.isProcessing = true;
      const partnerSocket = getPartnerSocket(session, role);

      // ✅ THIS is the only place partner_speaking fires — real audio arrived.
      send(partnerSocket, { type: 'partner_speaking' });
      send(ws, { type: 'processing_started' });

      try {
        const result = await processAudioChunk(
          sessionId, role, audioBase64, mimeType, inputLang, outputLang,
          (chunk) => {
            send(partnerSocket, {
              type: 'translated_audio_chunk',
              audioBase64: chunk.audioBase64,
              mimeType: 'audio/wav',
              index: chunk.index,
              text: chunk.text,
            });
          }
        );

        send(ws, { type: 'processing_done' });
        send(ws, { type: 'transcript', originalText: result.originalText, translatedText: result.translatedText });
        send(partnerSocket, { type: 'translated_audio_final', originalText: result.originalText, translatedText: result.translatedText });

        // Tell partner the lock is released so they can resume recording
        // (in case translated_audio_final didn't arrive cleanly)
        send(partnerSocket, { type: 'lock_released' });

      } catch (err) {
        console.error('[server] Gemini error:', err.message);
        send(ws, { type: 'error', message: 'AI processing failed: ' + err.message });
        // Make sure partner isn't stuck
        send(partnerSocket, { type: 'lock_released' });
      } finally {
        session.isProcessing = false;
      }
      return;
    }

    // ── END SESSION ──────────────────────────────────────────────────────────
    if (type === 'end_session') {
      const { sessionId, role } = message;
      cleanupSession(sessionId, role);
      return;
    }

    send(ws, { type: 'error', message: `Unknown message type: ${type}` });
  });

  ws.on('close', () => {
    console.log(`[server] Connection closed. Role: ${currentRole}, Session: ${currentSessionId}`);
    if (currentSessionId && currentRole) {
      cleanupSession(currentSessionId, currentRole);
    }
  });

  ws.on('error', (err) => {
    console.error('[server] WebSocket error:', err.message);
  });
});

console.log(`[server] ShakTranslate WebSocket server running on ws://localhost:${PORT}`);
console.log(`[server] Audio-first floor control active — partner_speaking only on real audio.`);
