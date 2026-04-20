const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const YTSearch   = require('youtube-search-api');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  // Only accept connections from the same host (no cross-origin WS)
  cors: { origin: false },
});

const PORT = process.env.PORT || 3000;

// ── Security middleware ─────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'https://www.youtube.com', 'https://s.ytimg.com'],
      frameSrc:    ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      imgSrc:      ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc:  ["'self'", 'wss:', 'ws:', 'https://suggestqueries.google.com'],
      mediaSrc:    ["'self'", 'blob:'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
    },
  },
}));

// Global rate limiter – max 120 requests / minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
});
app.use(globalLimiter);

// Tighter limit on search endpoint (expensive)
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Search rate limit exceeded.' },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Room store ──────────────────────────────────────────────
// rooms[roomId] = {
//   hostSocketId, passwordHash, currentVideoId,
//   syncMode, platform, playbackState
// }
const rooms = {};

// Simple SHA-256 hash (no need for bcrypt for a local hobby app)
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function getRoomUserCount(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  return room ? room.size : 0;
}

function getListenerIds(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return [];
  return [...room].filter(id => id !== rooms[roomId]?.hostSocketId);
}

// Track per-socket join attempt counts to prevent brute force
const joinAttempts = new Map(); // socketId → count
const MAX_JOIN_ATTEMPTS = 5;

// Rooms scheduled for deletion (30s grace period after host disconnects alone).
// Allows accidental refresh / brief network blip without losing the room.
const pendingDeletes = new Map(); // roomId → timeout
const ROOM_GRACE_MS  = 30 * 1000;

// Host handoff grace period — when host disconnects WITH listeners present,
// wait this long before promoting a listener. If host reconnects in time,
// they keep their role. Covers refresh use case.
const pendingHostHandoff = new Map(); // roomId → { timeout, oldHostId }
const HOST_GRACE_MS      = 8 * 1000;

function cancelPendingDelete(roomId) {
  const t = pendingDeletes.get(roomId);
  if (t) { clearTimeout(t); pendingDeletes.delete(roomId); }
}

function cancelPendingHostHandoff(roomId) {
  const entry = pendingHostHandoff.get(roomId);
  if (entry) { clearTimeout(entry.timeout); pendingHostHandoff.delete(roomId); }
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  joinAttempts.set(socket.id, 0);

  // ── Create Room ──────────────────────────────────────────
  socket.on('create-room', ({ roomId, displayName, password }, ack) => {
    if (!roomId || typeof roomId !== 'string')
      return ack && ack({ error: 'Invalid room ID.' });

    roomId = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (roomId.length < 2 || roomId.length > 32)
      return ack && ack({ error: 'Room ID must be 2–32 characters (letters, numbers, - _).' });

    if (!password || typeof password !== 'string' || password.trim().length < 4)
      return ack && ack({ error: 'Password must be at least 4 characters.' });

    // Recovery path: if room is in EITHER grace period (pending-delete when host
    // was alone, OR pending-host-handoff when host had listeners), allow the
    // original host to reclaim it by re-creating with the same password.
    const inGrace = rooms[roomId] && (pendingDeletes.has(roomId) || pendingHostHandoff.has(roomId));
    if (inGrace) {
      if (hashPassword(password.trim()) !== rooms[roomId].passwordHash)
        return ack && ack({ error: 'Room recovering — wrong password.' });
      cancelPendingDelete(roomId);
      cancelPendingHostHandoff(roomId);
      rooms[roomId].hostSocketId = socket.id;
      socket.displayName = (displayName || '').trim().slice(0, 24) || 'Host';
      socket.join(roomId);
      socket.roomId = roomId;
      socket.role   = 'host';
      console.log(`[recover-room] "${roomId}" reclaimed by ${socket.id}`);
      io.to(roomId).emit('user-count', { count: getRoomUserCount(roomId) });
      io.to(roomId).emit('host-returned', { hostId: socket.id });
      return ack && ack({ role: 'host', recovered: true,
        state: {
          videoId:              rooms[roomId].currentVideoId,
          isPlaying:            rooms[roomId].playbackState.isPlaying,
          currentTime:          rooms[roomId].playbackState.currentTime,
          lastUpdatedTimestamp: rooms[roomId].playbackState.lastUpdatedTimestamp,
        },
      });
    }

    if (rooms[roomId])
      return ack && ack({ error: 'Room name already taken — choose a different one.' });

    socket.displayName = (displayName || '').trim().slice(0, 24) || 'Host';

    rooms[roomId] = {
      hostSocketId:  socket.id,
      passwordHash:  hashPassword(password.trim()),
      currentVideoId: null,
      syncMode:      'strict',
      platform:      'youtube',
      playbackState: { isPlaying: false, currentTime: 0, lastUpdatedTimestamp: Date.now() },
    };

    socket.join(roomId);
    socket.roomId = roomId;
    socket.role   = 'host';

    console.log(`[create-room] "${roomId}" by ${socket.id}`);
    io.to(roomId).emit('user-count', { count: getRoomUserCount(roomId) });
    ack && ack({ role: 'host' });
  });

  // ── Join Room ────────────────────────────────────────────
  socket.on('join-room', ({ roomId, displayName, password }, ack) => {
    if (!roomId || typeof roomId !== 'string')
      return ack && ack({ error: 'Invalid room ID.' });

    roomId = roomId.trim().toLowerCase();
    const room = rooms[roomId];
    if (!room) return ack && ack({ error: 'Room not found. Check the room ID.' });

    // Brute-force protection
    const attempts = (joinAttempts.get(socket.id) || 0);
    if (attempts >= MAX_JOIN_ATTEMPTS)
      return ack && ack({ error: 'Too many failed attempts. Reconnect to try again.' });

    // Password check
    if (!password || hashPassword(password.trim()) !== room.passwordHash) {
      joinAttempts.set(socket.id, attempts + 1);
      const left = MAX_JOIN_ATTEMPTS - attempts - 1;
      return ack && ack({ error: `Wrong password.${left > 0 ? ` ${left} attempt${left !== 1 ? 's' : ''} left.` : ' No more attempts.'}` });
    }

    // Reset attempt count on success
    joinAttempts.set(socket.id, 0);
    // Joining cancels any pending room deletion
    cancelPendingDelete(roomId);
    socket.displayName = (displayName || '').trim().slice(0, 24) || 'Listener';

    socket.join(roomId);
    socket.roomId = roomId;
    socket.role   = 'listener';

    console.log(`[join-room] ${socket.id} joined "${roomId}"`);
    io.to(roomId).emit('user-count', { count: getRoomUserCount(roomId) });

    const roomSockets  = io.sockets.adapter.rooms.get(roomId);
    const existingPeers = roomSockets
      ? [...roomSockets].filter(id => id !== socket.id)
      : [];

    socket.to(roomId).emit('peer-joined', { peerId: socket.id });
    io.to(roomId).emit('chat-system', { text: `${socket.displayName} joined the room`, ts: Date.now() });

    ack && ack({
      role:    'listener',
      syncMode: room.syncMode,
      platform: room.platform,
      existingPeers,
      state: {
        videoId:              room.currentVideoId,
        isPlaying:            room.playbackState.isPlaying,
        currentTime:          room.playbackState.currentTime,
        lastUpdatedTimestamp: room.playbackState.lastUpdatedTimestamp,
      },
    });
  });

  // ── Load Video (host only) ───────────────────────────────
  socket.on('load-video', ({ roomId, videoId }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    room.currentVideoId = videoId;
    room.playbackState  = { isPlaying: false, currentTime: 0, lastUpdatedTimestamp: Date.now() };
    io.to(roomId).emit('video-loaded', { videoId });
  });

  // ── Play (host only) ─────────────────────────────────────
  socket.on('play', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    room.playbackState.isPlaying = true;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdatedTimestamp = Date.now();
    socket.to(roomId).emit('play', { currentTime });
  });

  // ── Pause (host only) ────────────────────────────────────
  socket.on('pause', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    room.playbackState.isPlaying = false;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdatedTimestamp = Date.now();
    socket.to(roomId).emit('pause', { currentTime });
  });

  // ── Seek (host only) ─────────────────────────────────────
  socket.on('seek', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdatedTimestamp = Date.now();
    socket.to(roomId).emit('seek', { currentTime });
  });

  // ── Heartbeat (host only) ────────────────────────────────
  socket.on('heartbeat', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdatedTimestamp = Date.now();
    socket.to(roomId).emit('sync-state', {
      currentTime,
      serverTimestamp: room.playbackState.lastUpdatedTimestamp,
      isPlaying:       room.playbackState.isPlaying,
    });
  });

  // ── Netflix timestamp (host only) ────────────────────────
  socket.on('netflix-time', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdatedTimestamp = Date.now();
    socket.to(roomId).emit('sync-state', {
      currentTime,
      serverTimestamp: room.playbackState.lastUpdatedTimestamp,
      isPlaying: true,
    });
  });

  // ── Sync Mode (host only) ────────────────────────────────
  socket.on('set-sync-mode', ({ roomId, syncMode }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    if (!['strict', 'soft'].includes(syncMode)) return;
    room.syncMode = syncMode;
    io.to(roomId).emit('sync-mode-changed', { syncMode });
  });

  // ── Platform (host only) ─────────────────────────────────
  socket.on('set-platform', ({ roomId, platform }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    if (!['youtube', 'netflix'].includes(platform)) return;
    room.platform = platform;
    io.to(roomId).emit('platform-changed', { platform });
  });

  // ── WebRTC signaling ─────────────────────────────────────
  socket.on('webrtc-offer', ({ roomId, offer, targetId }) => {
    // Only relay within the same room
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room || !room.has(socket.id)) return;
    if (targetId && room.has(targetId))
      io.to(targetId).emit('webrtc-offer', { offer, fromId: socket.id });
  });

  socket.on('webrtc-answer', ({ roomId, answer, targetId }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room || !room.has(socket.id)) return;
    if (targetId && room.has(targetId))
      io.to(targetId).emit('webrtc-answer', { answer, fromId: socket.id });
  });

  socket.on('webrtc-ice', ({ roomId, candidate, targetId }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room || !room.has(socket.id)) return;
    if (targetId && room.has(targetId))
      io.to(targetId).emit('webrtc-ice', { candidate, fromId: socket.id });
  });

  // ── Host switch ──────────────────────────────────────────
  socket.on('request-host', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId === socket.id) return;
    io.to(room.hostSocketId).emit('host-request', { requesterId: socket.id });
  });

  socket.on('respond-host-request', ({ roomId, requesterId, approved }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    if (!approved) { io.to(requesterId).emit('host-request-rejected', {}); return; }

    const oldHostId = room.hostSocketId;
    room.hostSocketId = requesterId;
    const nhs = io.sockets.sockets.get(requesterId);
    const ohs = io.sockets.sockets.get(oldHostId);
    if (nhs) nhs.role = 'host';
    if (ohs) ohs.role = 'listener';
    io.to(roomId).emit('host-transferred', { newHostId: requesterId, oldHostId });
  });

  // ── Chat ─────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room) return;
    // Must be in the room
    const roomSock = io.sockets.adapter.rooms.get(roomId);
    if (!roomSock || !roomSock.has(socket.id)) return;

    const trimmed = (text || '').toString().trim().slice(0, 500);
    if (!trimmed) return;

    io.to(roomId).emit('chat-message', {
      fromId:      socket.id,
      displayName: socket.displayName || (socket.role === 'host' ? 'Host' : 'Listener'),
      role:        socket.role || 'listener',
      text:        trimmed,
      ts:          Date.now(),
    });
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    joinAttempts.delete(socket.id);
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    if (rooms[roomId].hostSocketId === socket.id) {
      const listeners = getListenerIds(roomId).filter(id => id !== socket.id);
      if (listeners.length > 0) {
        // Host had listeners — give them 8s to refresh/reconnect before
        // promoting a listener. Keeps host role through a quick refresh.
        cancelPendingHostHandoff(roomId);
        const oldHostId = socket.id;
        const t = setTimeout(() => {
          const current = rooms[roomId];
          pendingHostHandoff.delete(roomId);
          if (!current) return;
          // Only promote if original host hasn't returned
          if (current.hostSocketId !== oldHostId) return;
          const remaining = getListenerIds(roomId);
          if (remaining.length === 0) return;
          const newHostId = remaining[0];
          current.hostSocketId = newHostId;
          const nhs = io.sockets.sockets.get(newHostId);
          if (nhs) nhs.role = 'host';
          io.to(roomId).emit('host-transferred', { newHostId, oldHostId, reason: 'disconnect' });
          console.log(`[host-handoff] "${roomId}" → ${newHostId} (grace expired)`);
        }, HOST_GRACE_MS);
        pendingHostHandoff.set(roomId, { timeout: t, oldHostId });
        io.to(roomId).emit('host-disconnected-temp', { graceMs: HOST_GRACE_MS });
        console.log(`[host-grace] "${roomId}" host ${oldHostId} disconnected — ${HOST_GRACE_MS}ms grace`);
      } else {
        // Host alone — schedule deletion with 30s grace period.
        // Allows refresh/reconnect to recover the room.
        cancelPendingDelete(roomId);
        const t = setTimeout(() => {
          io.to(roomId).emit('host-left', {});
          delete rooms[roomId];
          pendingDeletes.delete(roomId);
          console.log(`[room-deleted] "${roomId}" (grace period expired)`);
        }, ROOM_GRACE_MS);
        pendingDeletes.set(roomId, t);
        console.log(`[room-grace] "${roomId}" pending deletion in ${ROOM_GRACE_MS}ms`);
        return;
      }
    }

    const count = getRoomUserCount(roomId) - 1;
    io.to(roomId).emit('user-count', { count: Math.max(0, count) });
    socket.to(roomId).emit('peer-left',    { peerId: socket.id });
    socket.to(roomId).emit('chat-system',  { text: `${socket.displayName || 'Someone'} left the room`, ts: Date.now() });
  });
});

// ── Search API ───────────────────────────────────────────────
app.get('/api/search', searchLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  try {
    const data  = await YTSearch.GetListByKeyword(q, false, 8, [{ type: 'video' }]);
    const items = (data.items || []).map(v => ({
      id:        v.id,
      title:     v.title,
      channel:   v.channelTitle || '',
      thumbnail: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || '',
      duration:  v.length?.simpleText || '',
    }));
    res.json({ items });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ items: [], error: e.message });
  }
});

app.get('/api/suggest', searchLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const url  = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`;
    const r    = await fetch(url);
    const json = await r.json();
    res.json(json[1] || []);
  } catch (e) {
    res.json([]);
  }
});

server.listen(PORT, () => {
  console.log(`Watch Sync server running at http://localhost:${PORT}`);
});
