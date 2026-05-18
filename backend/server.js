require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { processAudioChunk, warmupSession, closeSession } = require('./geminiService');

const PORT = process.env.PORT || 8080;

// ─── HTTP Server (REST endpoints) ────────────────────────────────────────────
//
// We need a plain HTTP server to handle the /clerk/update-profile endpoint.
// The WebSocket server is attached to the same underlying http.Server so both
// share the same port on Render.

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.error('[server] CLERK_SECRET_KEY is not set — /clerk/update-profile will not work.');
}

/**
 * Extract the userId from a Clerk session token.
 *
 * Clerk tokens are standard JWTs. We decode the payload locally to read the
 * `sub` claim (userId) without making an extra HTTP roundtrip. The downstream
 * Clerk PATCH call will reject naturally if the token is tampered with, since
 * the userId won't match any real user in our Clerk instance.
 */
function verifyClerkToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed JWT — expected 3 parts');

    // base64url → JSON payload
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);

    if (!payload.sub) throw new Error('JWT has no sub claim');

    // Basic expiry check
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) {
      throw new Error('Token has expired');
    }

    return payload.sub; // userId e.g. "user_2abc..."
  } catch (err) {
    throw new Error('Invalid token: ' + err.message);
  }
}

/**
 * Write publicMetadata to a Clerk user via the Backend API.
 */
async function updateClerkMetadata(userId, metadata) {
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ public_metadata: metadata }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.errors?.[0]?.message ?? `Metadata update failed (${res.status})`);
  }
  return res.json();
}

const httpServer = http.createServer(async (req, res) => {
  // CORS for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST /clerk/update-profile ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/clerk/update-profile') {
    try {
      if (!CLERK_SECRET_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CLERK_SECRET_KEY not configured on server.' }));
        return;
      }

      // Parse body
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        req.on('error', reject);
      });

      const { age, gender } = body;
      if (!age || !gender) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'age and gender are required.' }));
        return;
      }

      // Verify the Clerk session token from Authorization header
      const authHeader = req.headers['authorization'] ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing Authorization header.' }));
        return;
      }

      const userId = await verifyClerkToken(token);

      // Write to Clerk publicMetadata
      await updateClerkMetadata(userId, {
        age: Number(age),
        gender,
        onboardingComplete: true,
      });

      console.log(`[server] Updated Clerk metadata for user ${userId}: age=${age}, gender=${gender}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[server] /clerk/update-profile error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Attach WebSocket server to the same underlying http.Server
const wss = new WebSocketServer({ server: httpServer });

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
      const { sessionId, role, audioBase64, mimeType, inputLang, outputLang, speakerGender, speakerAge } = message;
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
          // Voice profile from the sender's onboarding data
          { gender: speakerGender, age: speakerAge },
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

console.log(`[server] ShakTranslate server running on port ${PORT} (HTTP + WebSocket)`);
console.log(`[server] Audio-first floor control active — partner_speaking only on real audio.`);

httpServer.listen(PORT, () => {
  console.log(`[server] HTTP + WebSocket server listening on port ${PORT}`);
});
