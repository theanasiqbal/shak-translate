require('dotenv').config();
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { processAudioChunk, warmupSession, closeSession } = require('./geminiService');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

/**
 * Session store:
 * sessions = Map<sessionId, { host: WebSocket | null, guest: WebSocket | null, lockedBy: 'host' | 'guest' | null }>
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

  // Close partner socket too
  if (partnerSocket && partnerSocket.readyState === partnerSocket.OPEN) {
    partnerSocket.close();
  }

  // Clean up persistent Gemini Live sessions for both roles
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
      sessions.set(sessionId, { host: ws, hostLang: lang, guest: null, guestLang: null, lockedBy: null });
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

      // Notify both parties with their respective partner's language
      send(session.host, { type: 'session_ready', role: 'host', sessionId, partnerLang: session.guestLang });
      send(session.guest, { type: 'session_ready', role: 'guest', sessionId, partnerLang: session.hostLang });

      // Pre-warm Gemini Live connections for both roles so first translation is instant
      warmupSession(sessionId, 'host', session.hostLang, session.guestLang).catch(console.error);
      warmupSession(sessionId, 'guest', session.guestLang, session.hostLang).catch(console.error);
      return;
    }

    // ── FLOOR CONTROL (Turn-Taking) ──────────────────────────────────────────
    if (type === 'claim_turn') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;

      // If someone else already has the lock, reject this claim
      if (session.lockedBy && session.lockedBy !== role) {
        send(ws, { type: 'turn_rejected' });
        return;
      }

      // Grant lock to the sender
      session.lockedBy = role;

      // Notify partner
      const partnerSocket = getPartnerSocket(session, role);
      send(partnerSocket, { type: 'partner_speaking' });
      return;
    }

    if (type === 'release_turn') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;

      // Only the person who locked it can release it, or if it's already null
      if (session.lockedBy === role) {
        session.lockedBy = null;
      }
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

      const partnerSocket = getPartnerSocket(session, role);

      // Notify sender that processing has started
      send(ws, { type: 'processing_started' });

      try {
        const result = await processAudioChunk(
          sessionId,
          role,
          audioBase64,
          mimeType,
          inputLang,
          outputLang,
          (chunk) => {
            // Send each chunk as soon as TTS finishes
            send(partnerSocket, {
              type: 'translated_audio_chunk',
              audioBase64: chunk.audioBase64,
              mimeType: 'audio/wav',
              index: chunk.index,
              text: chunk.text
            });
          }
        );

        // Notify both that processing finished (stop loading indicator)
        send(ws, { type: 'processing_done' });

        // Send transcript back to sender for display
        send(ws, {
          type: 'transcript',
          originalText: result.originalText,
          translatedText: result.translatedText,
        });

        // Send the final text payload for the UI display to partner
        send(partnerSocket, {
          type: 'translated_audio_final',
          originalText: result.originalText,
          translatedText: result.translatedText,
        });

        // Free the lock so the other person can speak
        session.lockedBy = null;

      } catch (err) {
        session.lockedBy = null; // free lock on error
        console.error('[server] Gemini error:', err.message);
        send(ws, { type: 'error', message: 'AI processing failed: ' + err.message });
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
console.log(`[server] Share your local IP with the mobile devices, e.g. ws://192.168.x.x:${PORT}`);
