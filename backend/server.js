require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { processAudioChunk, warmupSession, closeSession } = require('./geminiService');
const { supabase } = require('./supabaseClient');
const { uploadAudio } = require('./storageService');

const PORT = process.env.PORT || 8080;

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.error('[server] CLERK_SECRET_KEY is not set — /clerk/update-profile will not work.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function verifyClerkToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed JWT — expected 3 parts');
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (!payload.sub) throw new Error('JWT has no sub claim');
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) throw new Error('Token has expired');
    return payload.sub;
  } catch (err) {
    throw new Error('Invalid token: ' + err.message);
  }
}

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── HTTP Server ───────────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /clerk/update-profile ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/clerk/update-profile') {
    try {
      if (!CLERK_SECRET_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CLERK_SECRET_KEY not configured on server.' }));
        return;
      }
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
      const authHeader = req.headers['authorization'] ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing Authorization header.' }));
        return;
      }
      const userId = await verifyClerkToken(token);
      await updateClerkMetadata(userId, { age: Number(age), gender, onboardingComplete: true });
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

  // ── GET /conversations?userId=... ──────────────────────────────────────────
  if (req.method === 'GET' && req.url?.match(/^\/conversations(\?.*)?$/)) {
    try {
      const url = new URL(req.url, `http://localhost`);
      const userId = url.searchParams.get('userId');
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userId is required' }));
        return;
      }

      // Fetch conversations where user is host or guest
      const { data: conversations, error } = await supabase
        .from('conversations')
        .select(`
          id, session_id, host_user_id, guest_user_id, host_lang, guest_lang, started_at, ended_at,
          messages(id, sender_user_id, role, original_text, translated_text, sent_at)
        `)
        .or(`host_user_id.eq.${userId},guest_user_id.eq.${userId}`)
        .order('started_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      // For each conversation, attach last message and format
      const result = (conversations || []).map(conv => {
        const msgs = (conv.messages || []).sort((a, b) =>
          new Date(a.sent_at) - new Date(b.sent_at)
        );
        const lastMsg = msgs[msgs.length - 1] || null;
        const partnerRole = conv.host_user_id === userId ? 'guest' : 'host';
        const partnerLang = partnerRole === 'guest' ? conv.guest_lang : conv.host_lang;
        const myLang = partnerRole === 'guest' ? conv.host_lang : conv.guest_lang;
        return {
          id: conv.id,
          sessionId: conv.session_id,
          myLang,
          partnerLang,
          startedAt: conv.started_at,
          endedAt: conv.ended_at,
          lastMessage: lastMsg ? {
            text: lastMsg.sender_user_id === userId ? lastMsg.original_text : lastMsg.translated_text,
            sentAt: lastMsg.sent_at,
            isMe: lastMsg.sender_user_id === userId,
          } : null,
          messageCount: msgs.length,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[server] /conversations error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /conversations/:id/messages ───────────────────────────────────────
  if (req.method === 'GET' && /^\/conversations\/[^/]+\/messages$/.test(req.url)) {
    try {
      const convId = req.url.split('/')[2];
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', convId)
        .order('sent_at', { ascending: true });

      if (error) throw error;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages || []));
    } catch (err) {
      console.error('[server] /conversations/:id/messages error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /conversations/:id/recordings ─────────────────────────────────────
  if (req.method === 'GET' && /^\/conversations\/[^/]+\/recordings$/.test(req.url)) {
    try {
      const convId = req.url.split('/')[2];
      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, sender_user_id, role, original_text, translated_text, original_audio_url, translated_audio_url, original_audio_offset_ms, sent_at')
        .eq('conversation_id', convId)
        .order('sent_at', { ascending: true });

      if (error) throw error;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages || []));
    } catch (err) {
      console.error('[server] /conversations/:id/recordings error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); res.end('OK'); return; }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

/**
 * ARCHITECTURE: Independent per-role queues + pause/resume barge-in
 *
 * Each role has its own FIFO queue. When a user speaks during partner's playback,
 * the client pauses local audio and sends pause_queue. The server drain loop waits
 * (without losing the queue) until resume_queue arrives, then continues.
 *
 * This enables seamless pause/resume like a phone call — no audio is ever lost.
 */

const sessions = new Map();
const MAX_QUEUE_DEPTH = 5; // Increased from 2 — pause model needs more headroom

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function getPartnerSocket(session, role) {
  return role === 'host' ? session.guest : session.host;
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function dbCreateConversation(sessionId, hostUserId, hostLang) {
  const { error } = await supabase.from('conversations').insert({
    session_id: sessionId,
    host_user_id: hostUserId,
    host_lang: hostLang,
  });
  if (error) console.error('[db] createConversation error:', error.message);
}

async function dbUpdateConversationGuest(sessionId, guestUserId, guestLang) {
  const { error } = await supabase.from('conversations')
    .update({ guest_user_id: guestUserId, guest_lang: guestLang })
    .eq('session_id', sessionId);
  if (error) console.error('[db] updateConversationGuest error:', error.message);
}

async function dbEndConversation(sessionId) {
  const { error } = await supabase.from('conversations')
    .update({ ended_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  if (error) console.error('[db] endConversation error:', error.message);
}

async function dbInsertMessage(sessionId, senderUserId, role, originalText, translatedText, originalAudioUrl, translatedAudioUrl, originalAudioOffsetMs = 0) {
  if (!originalText && !translatedText) {
    console.log('[db] Skipping insertMessage: both originalText and translatedText are empty');
    return;
  }

  // Get conversation id from session_id
  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('session_id', sessionId)
    .single();

  if (!conv) return;

  const { error } = await supabase.from('messages').insert({
    conversation_id: conv.id,
    sender_user_id: senderUserId,
    role,
    original_text: originalText || '',
    translated_text: translatedText || '',
    original_audio_url: originalAudioUrl || null,
    translated_audio_url: translatedAudioUrl || null,
    original_audio_offset_ms: Math.max(0, (originalAudioOffsetMs || 0) - 600),
  });
  if (error) console.error('[db] insertMessage error:', error.message);
}

// ── Queue drain ───────────────────────────────────────────────────────────────

async function drainRoleQueue(session, sessionId, role) {
  const rs = session.roleState[role];
  if (rs.isProcessing) return;

  rs.isProcessing = true;
  const senderSocket = () => role === 'host' ? session.host : session.guest;
  const partnerSocket = () => getPartnerSocket(session, role);

  while (rs.queue.length > 0) {
    if (!sessions.has(sessionId)) break;

    // ── PAUSE GATE: wait while partner is barging in ─────────────────────────
    while (rs.paused) {
      if (!sessions.has(sessionId)) break;
      await sleep(80);
    }
    if (!sessions.has(sessionId)) break;

    const entry = rs.queue.shift();

    send(partnerSocket(), { type: 'partner_speaking' });
    send(senderSocket(), { type: 'processing_started' });
    send(senderSocket(), { type: 'queue_depth', depth: rs.queue.length });

    try {
      const result = await processAudioChunk(
        sessionId, role,
        entry.audioBase64, entry.mimeType,
        entry.inputLang, entry.outputLang,
        { gender: entry.speakerGender, age: entry.speakerAge },
        (chunk) => {
          // Only send if not paused — client has paused local playback
          if (!rs.paused) {
            send(partnerSocket(), {
              type: 'translated_audio_chunk',
              audioBase64: chunk.audioBase64,
              mimeType: 'audio/wav',
              index: chunk.index,
              text: chunk.text,
            });
          }
        }
      );

      send(senderSocket(), { type: 'processing_done' });
      send(senderSocket(), {
        type: 'transcript',
        originalText: result.originalText,
        translatedText: result.translatedText,
      });
      send(partnerSocket(), {
        type: 'translated_audio_final',
        originalText: result.originalText,
        translatedText: result.translatedText,
      });

      if (rs.queue.length === 0) {
        send(partnerSocket(), { type: 'lock_released' });
      }

      // Upload audio files and persist message to Supabase (fire-and-forget)
      const senderUserId = role === 'host' ? session.hostUserId : session.guestUserId;
      console.log(`[db] Attempting to insert message for ${role}: original="${result.originalText}", translated="${result.translatedText}"`);
      if (senderUserId && (result.originalText || result.translatedText)) {
        const messageId = `${sessionId}-${role}-${Date.now()}`;

        // Upload both audio tracks concurrently
        Promise.all([
          uploadAudio(sessionId, messageId, 'original', entry.audioBase64),
          uploadAudio(sessionId, messageId, 'translated', result.translatedAudioBase64),
        ]).then(([originalAudioUrl, translatedAudioUrl]) => {
          console.log(`[storage] Uploaded orignal=${originalAudioUrl} translated=${translatedAudioUrl}`);
          return dbInsertMessage(
            sessionId, senderUserId, role,
            result.originalText, result.translatedText,
            originalAudioUrl, translatedAudioUrl,
            entry.speechStartOffsetMs
          );
        }).catch(e => console.error('[db] insertMessage+upload failed:', e.message));
      } else {
        console.log(`[db] Skipping insertMessage: senderUserId=${senderUserId}, originalText="${result.originalText}", translatedText="${result.translatedText}"`);
      }

    } catch (err) {
      console.error(`[server] Gemini error for ${role} in ${sessionId}:`, err.message);
      send(senderSocket(), { type: 'processing_done' });
      send(senderSocket(), { type: 'error', message: 'AI processing failed: ' + err.message });
      send(partnerSocket(), { type: 'lock_released' });
    }
  }

  rs.isProcessing = false;
  console.log(`[server] drainRoleQueue finished for ${role} in ${sessionId}`);
}

function cleanupSession(sessionId, disconnectedRole) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.roleState.host.queue = [];
  session.roleState.guest.queue = [];
  session.roleState.host.paused = false;
  session.roleState.guest.paused = false;

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

  dbEndConversation(sessionId).catch(e => console.error('[db] endConversation failed:', e.message));
  sessions.delete(sessionId);
  console.log(`[server] Session ${sessionId} cleaned up (${disconnectedRole} disconnected).`);
}

// ── WebSocket message handler ─────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('[server] New WebSocket connection');
  let currentSessionId = null;
  let currentRole = null;

  ws.on('message', async (data) => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch (e) { send(ws, { type: 'error', message: 'Invalid JSON message.' }); return; }

    const { type } = message;

    // ── CREATE SESSION (Host) ────────────────────────────────────────────────
    if (type === 'create_session') {
      const { lang, userId } = message;
      const sessionId = uuidv4();
      sessions.set(sessionId, {
        host: ws, hostLang: lang, hostUserId: userId || null,
        guest: null, guestLang: null, guestUserId: null,
        roleState: {
          host: { queue: [], isProcessing: false, paused: false },
          guest: { queue: [], isProcessing: false, paused: false },
        },
      });
      currentSessionId = sessionId;
      currentRole = 'host';
      console.log(`[server] Session created: ${sessionId} (Host lang: ${lang}, userId: ${userId})`);
      send(ws, { type: 'session_created', sessionId });

      // Persist conversation to Supabase
      if (userId) {
        dbCreateConversation(sessionId, userId, lang)
          .catch(e => console.error('[db] createConversation failed:', e.message));
      }
      return;
    }

    // ── JOIN SESSION (Guest) ─────────────────────────────────────────────────
    if (type === 'join_session') {
      const { sessionId, lang, userId } = message;
      const session = sessions.get(sessionId);

      if (!session) { send(ws, { type: 'error', message: `Session "${sessionId}" not found.` }); return; }
      if (session.guest) { send(ws, { type: 'error', message: `Session "${sessionId}" already has a guest.` }); return; }

      session.guest = ws;
      session.guestLang = lang;
      session.guestUserId = userId || null;
      currentSessionId = sessionId;
      currentRole = 'guest';
      console.log(`[server] Guest joined session: ${sessionId} (Guest lang: ${lang}, userId: ${userId})`);

      send(session.host, { type: 'session_ready', role: 'host', sessionId, partnerLang: session.guestLang });
      send(session.guest, { type: 'session_ready', role: 'guest', sessionId, partnerLang: session.hostLang });

      warmupSession(sessionId, 'host', session.hostLang, session.guestLang).catch(console.error);
      warmupSession(sessionId, 'guest', session.guestLang, session.hostLang).catch(console.error);

      // Update conversation with guest info
      if (userId) {
        dbUpdateConversationGuest(sessionId, userId, lang)
          .catch(e => console.error('[db] updateConversationGuest failed:', e.message));
      }
      return;
    }

    // ── FLOOR CONTROL (no-op) ────────────────────────────────────────────────
    if (type === 'claim_turn' || type === 'release_turn') return;

    // ── PAUSE QUEUE (barge-in: pause partner's drain loop) ───────────────────
    if (type === 'pause_queue') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.roleState[role]) {
        session.roleState[role].paused = true;
        console.log(`[server] Paused queue for ${role} in ${sessionId}`);
      }
      return;
    }

    // ── RESUME QUEUE (barge-in over: resume partner's drain loop) ────────────
    if (type === 'resume_queue') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      const rs = session.roleState[role];
      if (rs) {
        rs.paused = false;
        console.log(`[server] Resumed queue for ${role} in ${sessionId}`);
        // Restart drain if it had exited while paused
        if (!rs.isProcessing && rs.queue.length > 0) {
          drainRoleQueue(session, sessionId, role);
        }
        // Signal the partner that audio is resuming
        const partnerSocket = getPartnerSocket(session, role);
        send(partnerSocket, { type: 'queue_resumed' });
      }
      return;
    }

    // ── CANCEL QUEUE (backward compat — kept as alias for clear+resume) ──────
    if (type === 'cancel_queue') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.roleState[role]) {
        session.roleState[role].queue = [];
        session.roleState[role].paused = false;
        send(ws, { type: 'queue_cancelled' });
      }
      return;
    }

    // ── AUDIO CHUNK ──────────────────────────────────────────────────────────
    if (type === 'audio_chunk') {
      const { sessionId, role, audioBase64, mimeType, inputLang, outputLang, speechStartOffsetMs, speakerGender, speakerAge } = message;
      const session = sessions.get(sessionId);

      if (!session) { send(ws, { type: 'error', message: 'Session not found.' }); return; }
      if (!session.host || !session.guest) { send(ws, { type: 'error', message: 'Session not fully connected yet.' }); return; }

      const rs = session.roleState[role];

      if (rs.queue.length >= MAX_QUEUE_DEPTH) {
        console.warn(`[server] Queue overflow for ${role} in ${sessionId} — dropped oldest entry`);
        rs.queue.shift(); // Drop OLDEST to make room (not newest)
        send(ws, { type: 'processing_done' });
      }

      rs.queue.push({ audioBase64, mimeType, inputLang, outputLang, speechStartOffsetMs, speakerGender, speakerAge });
      send(ws, { type: 'queue_depth', depth: rs.queue.length - 1 });
      console.log(`[server] Queued chunk for ${role} in ${sessionId} (queue length: ${rs.queue.length})`);

      if (!rs.isProcessing) drainRoleQueue(session, sessionId, role);
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
    if (currentSessionId && currentRole) cleanupSession(currentSessionId, currentRole);
  });

  ws.on('error', (err) => { console.error('[server] WebSocket error:', err.message); });
});

console.log(`[server] ShakTranslate server starting on port ${PORT}`);
httpServer.listen(PORT, () => {
  console.log(`[server] HTTP + WebSocket server listening on port ${PORT}`);
});
