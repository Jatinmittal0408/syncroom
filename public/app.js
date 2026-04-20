/* ═══════════════════════════════════════════════════════════
   Watch Sync — Frontend
   ═══════════════════════════════════════════════════════════ */

// ── Global State ───────────────────────────────────────────
let socket        = null;
let player        = null;
let role          = null;         // 'host' | 'listener'
let currentRoomId = null;
let playerReady   = false;
let syncMode      = 'strict';     // 'strict' | 'soft'
let platform      = 'youtube';    // 'youtube' | 'netflix'

// Host-only
let suppressStateChange = false;
let heartbeatInterval   = null;
let hostVideoId         = null;
let seekCheckTime       = null;
let isPlaylistMode      = false;

// Video history for Prev button (single-video mode)
let videoHistory = [];
let historyIndex = -1;

// Listener-only
let listenerApplying    = false;
let listenerLocalPaused = false;
let hostIsPlaying       = false;

// Pending state when listener joins mid-session
let pendingState = null;

// ── WebRTC Voice Chat ──────────────────────────────────────
let peerConnection  = null;
let localStream     = null;
let micEnabled      = false;
let remotePeerId    = null;

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Free TURN relays (Metered OpenRelay) — needed when both peers are
    // behind symmetric NAT (very common on cellular/mobile networks).
    // Without these, mic fails between users on different networks.
    { urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// ── Host-request modal state ───────────────────────────────
let pendingHostRequesterId = null;

// ── DOM refs ───────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const landingEl         = $('landing');
const roomEl            = $('room');
const roomIdInput       = $('room-id-input');
const landingError      = $('landing-error');
const btnCreate         = $('btn-create');
const btnJoin           = $('btn-join');

const roomNameDisplay   = $('room-name-display');
const roleBadge         = $('role-badge');
const connStatus        = $('conn-status');
const userCountDisplay  = $('user-count-display');
const ytUrlInput        = $('yt-url-input');
const btnLoad           = $('btn-load');
const btnPrev           = $('btn-prev');
const btnNext           = $('btn-next');
const playerPlaceholder = $('player-placeholder');
const playerBlocker     = $('player-blocker');
const syncDot           = $('sync-dot');
const syncLabel         = $('sync-label');
const roomIdDisplay     = $('room-id-display');
const toastEl           = $('toast');
const remoteAudio       = $('remote-audio');
const micStatus         = $('mic-status');

const platformSelect    = $('platform-select');
const syncModeSelect    = $('sync-mode-select');
const btnMic            = $('btn-mic');
const btnRequestHost    = $('btn-request-host');

// Chat
const chatMessages   = $('chat-messages');
const chatInput      = $('chat-input');
const btnChatSend    = $('btn-chat-send');
const chatUnread     = $('chat-unread');
const displayNameInput = $('display-name-input');

let chatUnreadCount = 0;

const modalOverlay      = $('modal-overlay');
const modalMsg          = $('modal-msg');
const btnApproveHost    = $('btn-approve-host');
const btnRejectHost     = $('btn-reject-host');
const netflixPanel      = $('netflix-panel');
const netflixTimeInput  = $('netflix-time-input');
const btnNetflixSync    = $('btn-netflix-sync');
const roomPasswordInput = $('room-password-input');

// ── Session persistence (survives refresh / brief disconnect) ──
// We store the room creds in sessionStorage and auto-rejoin on:
//   1. Initial page load (if session exists → user just refreshed)
//   2. Socket reconnect (if currentRoomId still set → brief network blip)
// This fixes the "refresh kicks me out" bug and the "chat stops working
// after a while" bug (silent socket reconnects re-joining the room).
const SESSION_KEY = 'syncroom-session';
let isAutoRejoining = false;

function saveSession(extra = {}) {
  if (!currentRoomId) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      roomId:      currentRoomId,
      role:        role,
      displayName: displayNameInput?.value?.trim() || extra.displayName || '',
      password:    roomPasswordInput?.value?.trim() || extra.password || '',
    }));
  } catch (e) {}
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
}

// ── Utilities ──────────────────────────────────────────────
function extractVideoId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractPlaylistId(url) {
  if (!url) return null;
  const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  // YouTube Radio/Mix playlists start with RD — they can't be loaded via
  // loadPlaylist(). Treat them as single videos; YouTube's autoplay handles the rest.
  if (m[1].startsWith('RD') || m[1].startsWith('RDMM')) return null;
  return m[1];
}

function updateNowPlaying(title) {
  const el = $('now-playing');
  if (el) el.textContent = title || 'No video loaded';
}

let toastTimer = null;
function showToast(msg, duration = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

function setSyncStatus(state, text) {
  syncDot.className = '';
  syncDot.classList.add(state);
  syncLabel.textContent = text;
}

function setConnStatus(connected) {
  connStatus.textContent = connected ? '● Connected' : '● Disconnected';
  connStatus.className = connected ? 'connected' : 'disconnected';
}

function setUserCount(count) {
  userCountDisplay.textContent = `${count} user${count !== 1 ? 's' : ''}`;
}

function setLandingError(msg) { landingError.textContent = msg; }

// ── Player blocker overlay ─────────────────────────────────
// Shows a transparent div on top of the YouTube iframe.
// Used for:
//   1. Listener + strict mode  → always shown  (blocks all YT controls)
//   2. Listener + video ENDED  → shown briefly  (blocks end-screen nav cards)
// Host's player is NEVER blocked — YouTube's autoplay countdown must work freely.
function showPlayerBlocker(show) {
  if (playerBlocker) playerBlocker.style.display = show ? 'block' : 'none';
}

function updatePlayerBlocker() {
  showPlayerBlocker(role === 'listener' && syncMode === 'strict');
}

// ── Sync mode ──────────────────────────────────────────────
function applySyncMode(mode) {
  syncMode = mode;
  if (syncModeSelect) syncModeSelect.value = mode;
  updatePlayerBlocker();
  if (role === 'listener') {
    showToast(mode === 'strict'
      ? 'Strict mode: host controls everything'
      : 'Soft mode: you can pause locally');
  }
}

// ── Platform ───────────────────────────────────────────────
function applyPlatform(p) {
  platform = p;
  if (platformSelect) platformSelect.value = p;
  const isYT = p === 'youtube';
  $('player-wrapper').style.display  = isYT ? '' : 'none';
  $('url-row').style.display         = isYT ? '' : 'none';
  $('controls-row').style.display    = isYT ? '' : 'none';
  if (netflixPanel) netflixPanel.style.display = isYT ? 'none' : 'block';
}

// ── Controls: host vs listener ─────────────────────────────
function setHostControls() {
  if (searchInput) { searchInput.disabled = false; searchInput.placeholder = '🔍 Search YouTube…'; }
  if (btnSearch)   { btnSearch.disabled = false; btnSearch.style.opacity = ''; }
  ytUrlInput.disabled    = false;
  ytUrlInput.placeholder = 'Or paste YouTube URL directly…';
  btnLoad.disabled       = false;
  btnLoad.style.opacity  = '';
  btnPrev.disabled       = false;
  btnPrev.style.opacity  = '';
  btnNext.disabled       = false;
  btnNext.style.opacity  = '';
  if (platformSelect) platformSelect.disabled = false;
  if (syncModeSelect) syncModeSelect.disabled = false;
  if (btnRequestHost) btnRequestHost.style.display = 'none';
  updatePlayerBlocker();
}

function setListenerControls() {
  if (searchInput) { searchInput.disabled = true; searchInput.placeholder = 'Search controlled by host…'; }
  if (btnSearch)   { btnSearch.disabled = true; btnSearch.style.opacity = '0.35'; }
  ytUrlInput.disabled    = true;
  ytUrlInput.placeholder = 'Controlled by host…';
  btnLoad.disabled       = true;
  btnLoad.style.opacity  = '0.35';
  btnPrev.disabled       = true;
  btnPrev.style.opacity  = '0.35';
  btnNext.disabled       = true;
  btnNext.style.opacity  = '0.35';
  if (platformSelect) platformSelect.disabled = true;
  if (syncModeSelect) syncModeSelect.disabled = true;
  if (btnRequestHost) btnRequestHost.style.display = '';
  updatePlayerBlocker();
}

// ── Enter room ─────────────────────────────────────────────
function enterRoom(roomId, myRole) {
  currentRoomId = roomId;
  role = myRole;
  landingEl.style.display = 'none';
  roomEl.style.display    = 'flex';
  if (roomNameDisplay) roomNameDisplay.textContent = roomId;
  const headerRoom = $('header-room');
  if (headerRoom) headerRoom.textContent = `# ${roomId}`;
  roomIdDisplay.textContent = `Room: ${roomId}`;
  if (myRole === 'host') {
    roleBadge.textContent = 'Host';
    roleBadge.className   = 'badge badge-host';
    setHostControls();
  } else {
    roleBadge.textContent = 'Listener';
    roleBadge.className   = 'badge badge-listen';
    setListenerControls();
  }
  saveSession();
}

// ── Role switch ────────────────────────────────────────────
function becomeHost() {
  role = 'host';
  roleBadge.textContent = 'Host';
  roleBadge.className   = 'badge badge-host';
  setHostControls();
  if (playerReady) startHeartbeat();
  setupMediaSession();
  saveSession();
  showToast('You are now the host!');
}

function becomeListener() {
  role = 'listener';
  roleBadge.textContent = 'Listener';
  roleBadge.className   = 'badge badge-listen';
  stopHeartbeat();
  setListenerControls();
  saveSession();
  showToast('You are now a listener.');
}

// ── Video history ──────────────────────────────────────────
function pushToHistory(videoId) {
  if (!videoId) return;
  if (historyIndex < videoHistory.length - 1) {
    videoHistory = videoHistory.slice(0, historyIndex + 1);
  }
  if (videoHistory[videoHistory.length - 1] !== videoId) {
    videoHistory.push(videoId);
    historyIndex = videoHistory.length - 1;
  }
}

// ── WebRTC ─────────────────────────────────────────────────
function createPeerConnection() {
  if (peerConnection) return;

  peerConnection = new RTCPeerConnection(RTC_CONFIG);

  // onnegotiationneeded fires whenever local tracks change.
  // This is the key to bidirectional audio: when user B adds their mic tracks
  // to an existing connection, this event fires and sends a new offer to A,
  // so A can receive B's audio without rebuilding the whole connection.
  peerConnection.onnegotiationneeded = async () => {
    if (!remotePeerId) return;
    if (peerConnection.signalingState !== 'stable') return;
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc-offer', { roomId: currentRoomId, offer, targetId: remotePeerId });
      console.log('[webrtc] renegotiation offer sent');
    } catch (e) {
      console.error('[webrtc] onnegotiationneeded error', e);
    }
  };

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate && remotePeerId) {
      socket.emit('webrtc-ice', { roomId: currentRoomId, candidate, targetId: remotePeerId });
    }
  };

  // Remote audio track arrives → play it through the hidden <audio> element
  peerConnection.ontrack = ({ streams, track }) => {
    console.log('[webrtc] remote track:', track.kind);
    if (streams && streams[0]) remoteAudio.srcObject = streams[0];
  };

  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection.connectionState;
    console.log('[webrtc] state:', s);
    if (s === 'connected') {
      if (micStatus) { micStatus.textContent = '🎙 Voice connected'; micStatus.className = 'active'; }
    } else if (s === 'failed') {
      closeRTC();
      showToast('Voice connection failed — toggle mic to retry.');
    }
  };

  // If mic is already on when connection is created, add tracks immediately
  if (localStream) {
    localStream.getTracks().forEach(track => {
      if (!peerConnection.getSenders().find(s => s.track === track)) {
        peerConnection.addTrack(track, localStream);
      }
    });
  }
}

async function startMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micEnabled = true;
    updateMicUI(true);

    if (!peerConnection) createPeerConnection();

    // Adding tracks triggers onnegotiationneeded automatically.
    // If remotePeerId is already set, a new offer will be sent → other side
    // updates and starts receiving our audio. This is what enables bidirectional audio.
    localStream.getTracks().forEach(track => {
      const already = peerConnection.getSenders().some(s => s.track === track);
      if (!already) peerConnection.addTrack(track, localStream);
    });

    showToast(remotePeerId ? '🎙 Mic on — broadcasting' : '🎙 Mic on — waiting for peer');
  } catch (err) {
    showToast('Mic error: ' + err.message);
  }
}

function stopMic() {
  if (localStream) {
    // Remove senders (triggers renegotiation → peer stops hearing us)
    // Does NOT close the connection so we can still hear them.
    if (peerConnection) {
      peerConnection.getSenders()
        .filter(s => s.track && s.track.kind === 'audio')
        .forEach(s => { try { peerConnection.removeTrack(s); } catch (e) {} });
    }
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  micEnabled = false;
  updateMicUI(false);
  showToast('🎙 Mic off');
}

function closeRTC() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  remoteAudio.srcObject = null;
  micEnabled = false;
  updateMicUI(false);
}

function updateMicUI(on) {
  if (btnMic) {
    btnMic.textContent = on ? '🎙 Mic On' : '🎙 Mic Off';
    btnMic.className   = on ? 'btn-mic-on' : 'btn-secondary';
  }
  if (micStatus) {
    micStatus.textContent = on ? '🎙 Mic on' : '🎙 Mic off';
    micStatus.className   = on ? 'active' : '';
  }
}

// ── Media Session API — earphone/headphone button support ──
// Lets the HOST control playback via earphone buttons (play/pause/next/prev).
//
// "Next" on a single video: skips to 2s before the end so YouTube's
// built-in 5-second recommendation countdown fires and autoplays the next song.
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.setActionHandler('play', () => {
    if (role === 'host' && playerReady) player.playVideo();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    if (role === 'host' && playerReady) player.pauseVideo();
  });
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    if (role !== 'host' || !playerReady) return;
    if (isPlaylistMode) {
      player.nextVideo();
    } else if (hostVideoId) {
      isPlaylistMode = true;
      player.loadPlaylist({ listType: 'playlist', list: 'RD' + hostVideoId, index: 1 });
    }
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if (role !== 'host' || !playerReady) return;
    if (isPlaylistMode) {
      player.previousVideo();
    } else if (historyIndex > 0) {
      historyIndex--;
      loadAndBroadcastVideo(videoHistory[historyIndex]);
    }
  });

  window._refreshMediaMetadata = () => {
    if (!player || !playerReady) return;
    const data = player.getVideoData && player.getVideoData();
    if (!data || !data.title) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  data.title  || 'YouTube Sync',
      artist: data.author || '',
      album:  'Watch Sync',
    });
  };
}

// ── Auto-rejoin (refresh recovery + reconnect after net blip) ──
// Tries to put us back in our previous room. Used by:
//   • Initial page load → user just refreshed (sessionStorage still has creds)
//   • Socket reconnect  → brief network drop (currentRoomId still set client-side
//     but server-side our new socket.id isn't in the Socket.IO room → chat etc. would silently fail)
function tryAutoRejoin() {
  if (isAutoRejoining) return;
  const session = loadSession();
  if (!session || !session.roomId || !session.password) return;

  isAutoRejoining = true;

  // Helper: fall back to join-room as listener (or whatever the server gives us)
  const fallbackJoin = () => {
    socket.emit('join-room', {
      roomId:      session.roomId,
      displayName: session.displayName,
      password:    session.password,
    }, (res) => {
      isAutoRejoining = false;
      if (!res || res.error) {
        clearSession();
        if (currentRoomId) {
          showToast(res?.error || 'Room no longer exists');
          setTimeout(() => location.reload(), 1500);
        }
        return;
      }
      if (!currentRoomId) {
        enterRoom(session.roomId, res.role || 'listener');
        applySyncMode(res.syncMode || 'strict');
        applyPlatform(res.platform || 'youtube');
        if (res.state && res.state.videoId) {
          pendingState  = res.state;
          hostIsPlaying = res.state.isPlaying;
          loadPlayerVideo(res.state.videoId);
        }
      }
    });
  };

  // If we WERE the host, try to reclaim host first via create-room.
  // The server's "recovery path" lets the original host reclaim a room that's
  // in the 30s grace period (after refresh) by re-creating with the same password.
  if (session.role === 'host') {
    socket.emit('create-room', {
      roomId:      session.roomId,
      displayName: session.displayName,
      password:    session.password,
    }, (res) => {
      if (res && !res.error) {
        isAutoRejoining = false;
        if (!currentRoomId) {
          enterRoom(session.roomId, 'host');
          setupMediaSession();
          if (res.recovered && res.state && res.state.videoId) {
            pendingState  = res.state;
            hostIsPlaying = res.state.isPlaying;
            loadPlayerVideo(res.state.videoId);
            showToast('Room recovered — you are still host');
          } else if (res.recovered) {
            showToast('Room recovered — you are still host');
          }
        } else if (res.recovered) {
          showToast('Reconnected — host role restored');
        }
        return;
      }
      // Recovery failed (room taken over by another listener, grace expired,
      // or someone re-created with different password). Fall back to listener join.
      fallbackJoin();
    });
  } else {
    fallbackJoin();
  }
}

// ── Socket setup ───────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    setConnStatus(true);
    // On every connect (initial OR reconnect), if we have a stored session,
    // try to put ourselves back in the room. This fixes:
    //   • Refresh kicks me out → restored automatically
    //   • Chat dies after a while → caused by silent reconnects with new socket.id
    //     not being in the Socket.IO room. Auto-rejoin re-adds us.
    setTimeout(tryAutoRejoin, 50);
  });
  socket.on('disconnect', () => {
    setConnStatus(false);
    setSyncStatus('waiting', 'Reconnecting…');
    stopHeartbeat();
  });

  // ── video-loaded ──────────────────────────────────────
  socket.on('video-loaded', ({ videoId }) => {
    console.log('[recv] video-loaded', videoId);
    if (role === 'listener') {
      hostIsPlaying = false;
      // Cue (don't autoplay) — listener waits for host's 'play' event
      if (playerReady) {
        listenerApplying = true;
        player.cueVideoById(videoId);
        setTimeout(() => { listenerApplying = false; }, 600);
        updatePlayerBlocker();
      } else {
        pendingState = { videoId, isPlaying: false, currentTime: 0 };
      }
    }
    setSyncStatus('waiting', 'Loading video…');
    updateNowPlaying(videoId);
  });

  // ── play ─────────────────────────────────────────────
  socket.on('play', ({ currentTime }) => {
    if (role !== 'listener' || !playerReady) return;
    hostIsPlaying = true;
    // If we were blocked at end-screen, unblock now (host started new content)
    if (syncMode === 'soft') showPlayerBlocker(false);
    listenerApplying = true;
    player.seekTo(currentTime, true);
    player.playVideo();
    setTimeout(() => { listenerApplying = false; }, 500);
    setSyncStatus('synced', 'Playing');
  });

  // ── pause ────────────────────────────────────────────
  socket.on('pause', ({ currentTime }) => {
    if (role !== 'listener' || !playerReady) return;
    hostIsPlaying = false;
    listenerApplying = true;
    player.seekTo(currentTime, true);
    player.pauseVideo();
    setTimeout(() => { listenerApplying = false; }, 500);
    setSyncStatus('synced', 'Paused');
  });

  // ── seek ─────────────────────────────────────────────
  socket.on('seek', ({ currentTime }) => {
    if (role !== 'listener' || !playerReady) return;
    listenerApplying = true;
    player.seekTo(currentTime, true);
    setTimeout(() => { listenerApplying = false; }, 500);
  });

  // ── sync-state (heartbeat drift correction) ──────────
  socket.on('sync-state', ({ currentTime, serverTimestamp, isPlaying }) => {
    if (role !== 'listener' || !playerReady) return;

    if (syncMode === 'soft' && listenerLocalPaused) {
      setSyncStatus('synced', `Paused locally · Host @ ${currentTime.toFixed(0)}s`);
      return;
    }

    const networkDelaySec = (Date.now() - serverTimestamp) / 1000;
    const expectedTime    = isPlaying ? currentTime + networkDelaySec : currentTime;
    const actualTime      = player.getCurrentTime();
    const drift           = Math.abs(expectedTime - actualTime);

    if (drift > 1.0) {
      setSyncStatus('resyncing', `Re-syncing… (${drift.toFixed(1)}s)`);
      listenerApplying = true;
      player.seekTo(expectedTime, true);
      setTimeout(() => { listenerApplying = false; }, 500);
    } else {
      setSyncStatus('synced', isPlaying ? 'Playing · Synced' : 'Paused · Synced');
    }
  });

  socket.on('user-count', ({ count }) => setUserCount(count));

  socket.on('host-left', () => {
    setSyncStatus('waiting', 'Host disconnected');
    showToast('The host has left the room.');
    if (playerReady) player.pauseVideo();
  });

  socket.on('sync-mode-changed',  ({ syncMode: m }) => applySyncMode(m));
  socket.on('platform-changed',   ({ platform: p }) => applyPlatform(p));

  socket.on('host-transferred', ({ newHostId, oldHostId, reason }) => {
    if (newHostId === socket.id) {
      becomeHost();
    } else if (oldHostId === socket.id) {
      becomeListener();
    } else {
      showToast(reason === 'disconnect'
        ? 'Host disconnected — new host assigned.'
        : 'Host role transferred.');
    }
  });

  socket.on('host-request', ({ requesterId }) => {
    if (role !== 'host') return;
    pendingHostRequesterId = requesterId;
    if (modalMsg) modalMsg.textContent = 'A listener wants to take over as host. Approve?';
    if (modalOverlay) modalOverlay.classList.add('show');
  });

  socket.on('host-request-rejected', () => showToast('Host rejected your request.'));

  // Host briefly disconnected (refresh / net blip). Listeners see this so
  // they know the silence isn't a bug — and they don't prematurely lose sync.
  socket.on('host-disconnected-temp', ({ graceMs }) => {
    if (role !== 'host') {
      setSyncStatus('waiting', `Host reconnecting… (${Math.ceil(graceMs/1000)}s)`);
      showToast('Host disconnected briefly — waiting…');
    }
  });

  socket.on('host-returned', ({ hostId }) => {
    if (hostId === socket.id) return;
    setSyncStatus('synced', 'Host reconnected');
    showToast('Host is back!');
  });

  // ── Chat ─────────────────────────────────────────────
  socket.on('chat-message', (msg) => {
    appendChatMessage({
      type:        'message',
      mine:        msg.fromId === socket.id,
      displayName: msg.displayName,
      role:        msg.role,
      text:        msg.text,
      ts:          msg.ts,
    });
  });

  socket.on('chat-system', ({ text, ts }) => {
    appendChatMessage({ type: 'system', text, ts });
  });

  // ── WebRTC signaling ─────────────────────────────────

  // Fired on existing peers when someone new joins the room.
  socket.on('peer-joined', ({ peerId }) => {
    console.log('[webrtc] peer joined:', peerId);
    remotePeerId = peerId;
    createPeerConnection();
    // If mic is already on: add tracks if not already added (triggers onnegotiationneeded)
    if (micEnabled && localStream) {
      const senders = peerConnection.getSenders();
      const allAdded = localStream.getTracks().every(t => senders.some(s => s.track === t));
      if (!allAdded) {
        localStream.getTracks().forEach(track => {
          if (!senders.find(s => s.track === track)) peerConnection.addTrack(track, localStream);
        });
      } else {
        // Tracks already added before peer was known — send offer manually now
        (async () => {
          if (peerConnection.signalingState !== 'stable') return;
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          socket.emit('webrtc-offer', { roomId: currentRoomId, offer, targetId: remotePeerId });
        })();
      }
    }
  });

  socket.on('peer-left', ({ peerId }) => {
    if (peerId === remotePeerId) { closeRTC(); remotePeerId = null; }
  });

  socket.on('webrtc-offer', async ({ offer, fromId }) => {
    console.log('[webrtc] offer from', fromId);
    remotePeerId = fromId;
    createPeerConnection();
    try {
      // Glare handling: if both sides created offers at the same time
      if (peerConnection.signalingState === 'have-local-offer') {
        if (socket.id > fromId) {
          // They win: rollback ours and accept theirs
          await peerConnection.setLocalDescription({ type: 'rollback' });
        } else {
          return; // We win: ignore their offer
        }
      }
      await peerConnection.setRemoteDescription(offer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc-answer', { roomId: currentRoomId, answer, targetId: fromId });
    } catch (e) {
      console.error('[webrtc] handle offer error', e);
    }
  });

  socket.on('webrtc-answer', async ({ answer }) => {
    if (!peerConnection) return;
    try { await peerConnection.setRemoteDescription(answer); }
    catch (e) { console.error('[webrtc] handle answer error', e); }
  });

  socket.on('webrtc-ice', async ({ candidate }) => {
    if (!peerConnection) return;
    try { await peerConnection.addIceCandidate(candidate); } catch (e) {}
  });
}

// ── Landing buttons ────────────────────────────────────────
btnCreate.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim().toLowerCase();
  if (!roomId) { setLandingError('Enter a room ID.'); return; }
  setLandingError('');
  btnCreate.disabled = btnJoin.disabled = true;

  const displayName = displayNameInput ? displayNameInput.value.trim() : '';
  const password    = roomPasswordInput ? roomPasswordInput.value.trim() : '';
  if (!password || password.length < 4) { setLandingError('Password must be at least 4 characters.'); btnCreate.disabled = btnJoin.disabled = false; return; }
  socket.emit('create-room', { roomId, displayName, password }, (res) => {
    if (res.error) {
      setLandingError(res.error);
      btnCreate.disabled = btnJoin.disabled = false;
    } else {
      enterRoom(roomId, 'host');
      setupMediaSession();
    }
  });
});

btnJoin.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim().toLowerCase();
  if (!roomId) { setLandingError('Enter a room ID.'); return; }
  setLandingError('');
  btnCreate.disabled = btnJoin.disabled = true;

  const displayName = displayNameInput ? displayNameInput.value.trim() : '';
  const password    = roomPasswordInput ? roomPasswordInput.value.trim() : '';
  if (!password) { setLandingError('Enter the room password.'); btnCreate.disabled = btnJoin.disabled = false; return; }
  socket.emit('join-room', { roomId, displayName, password }, (res) => {
    if (res.error) {
      setLandingError(res.error);
      btnCreate.disabled = btnJoin.disabled = false;
      return;
    }

    enterRoom(roomId, 'listener');
    applySyncMode(res.syncMode || 'strict');
    applyPlatform(res.platform || 'youtube');

    // Set up WebRTC with any existing peers so we can receive their mic audio
    if (res.existingPeers && res.existingPeers.length > 0) {
      remotePeerId = res.existingPeers[0];
      createPeerConnection();
    }

    if (res.state && res.state.videoId) {
      pendingState = res.state;
      hostIsPlaying = res.state.isPlaying;
      loadPlayerVideo(res.state.videoId);
    } else {
      setSyncStatus('waiting', 'Waiting for host to load a video…');
    }
  });
});

roomIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnJoin.click(); });

// ── Toolbar controls (host only) ───────────────────────────
if (platformSelect) {
  platformSelect.addEventListener('change', () => {
    if (role !== 'host') return;
    const p = platformSelect.value;
    socket.emit('set-platform', { roomId: currentRoomId, platform: p });
    applyPlatform(p);
  });
}

if (syncModeSelect) {
  syncModeSelect.addEventListener('change', () => {
    if (role !== 'host') return;
    const mode = syncModeSelect.value;
    socket.emit('set-sync-mode', { roomId: currentRoomId, syncMode: mode });
    applySyncMode(mode);
  });
}

if (btnMic) {
  btnMic.addEventListener('click', () => {
    if (micEnabled) stopMic(); else startMic();
  });
}

if (btnRequestHost) {
  btnRequestHost.addEventListener('click', () => {
    socket.emit('request-host', { roomId: currentRoomId });
    showToast('Host control requested…');
    btnRequestHost.disabled = true;
    setTimeout(() => { btnRequestHost.disabled = false; }, 5000);
  });
}

if (btnApproveHost) {
  btnApproveHost.addEventListener('click', () => {
    if (!pendingHostRequesterId) return;
    socket.emit('respond-host-request', { roomId: currentRoomId, requesterId: pendingHostRequesterId, approved: true });
    modalOverlay.classList.remove('show');
    pendingHostRequesterId = null;
  });
}

if (btnRejectHost) {
  btnRejectHost.addEventListener('click', () => {
    if (!pendingHostRequesterId) return;
    socket.emit('respond-host-request', { roomId: currentRoomId, requesterId: pendingHostRequesterId, approved: false });
    modalOverlay.classList.remove('show');
    pendingHostRequesterId = null;
  });
}

// ── Load video (host) ──────────────────────────────────────
btnLoad.addEventListener('click', () => {
  if (role !== 'host') return;
  const url        = ytUrlInput.value.trim();
  const playlistId = extractPlaylistId(url);
  const videoId    = extractVideoId(url);

  if (!videoId && !playlistId) { showToast('Invalid YouTube URL.'); return; }

  if (playlistId) {
    isPlaylistMode = true;
    suppressStateChange = true;
    playerPlaceholder.style.display = 'none';
    player.loadPlaylist({ listType: 'playlist', list: playlistId, index: 0 });
    setTimeout(() => { suppressStateChange = false; }, 1000);
    setSyncStatus('waiting', 'Loading playlist…');
    showToast('Playlist loaded — Prev / Next active');
  } else {
    isPlaylistMode = false;
    loadAndBroadcastVideo(videoId);
  }
});

ytUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnLoad.click(); });

// Load a single video locally and tell all listeners
function loadAndBroadcastVideo(videoId) {
  if (!videoId) return;
  hostVideoId = videoId;
  pushToHistory(videoId);
  socket.emit('load-video', { roomId: currentRoomId, videoId });
  playerPlaceholder.style.display = 'none';
  if (!playerReady) { pendingState = { videoId, autoplay: true }; return; }
  suppressStateChange = true;
  player.loadVideoById(videoId);
  setTimeout(() => { suppressStateChange = false; }, 800);
  setSyncStatus('waiting', 'Loading video…');
}

// ── Prev / Next ────────────────────────────────────────────
btnPrev.addEventListener('click', () => {
  if (!playerReady || role !== 'host') return;
  if (isPlaylistMode) {
    player.previousVideo();
  } else if (historyIndex > 0) {
    historyIndex--;
    const prevId = videoHistory[historyIndex];
    hostVideoId = prevId;
    socket.emit('load-video', { roomId: currentRoomId, videoId: prevId });
    suppressStateChange = true;
    player.loadVideoById(prevId);
    setTimeout(() => { suppressStateChange = false; }, 800);
    showToast('Playing previous video');
  } else {
    showToast('No previous video in history.');
  }
});

btnNext.addEventListener('click', () => {
  if (!playerReady || role !== 'host') return;
  if (isPlaylistMode) {
    player.nextVideo();
  } else if (hostVideoId) {
    // Start YouTube Radio for the current song and jump to first recommendation
    setSyncStatus('waiting', 'Loading next recommendation…');
    isPlaylistMode = true;
    player.loadPlaylist({ listType: 'playlist', list: 'RD' + hostVideoId, index: 1 });
    showToast('YouTube Radio started…');
  }
});

// ── Netflix manual timestamp sync ─────────────────────────
if (btnNetflixSync) {
  btnNetflixSync.addEventListener('click', () => {
    if (role !== 'host') return;
    const raw     = (netflixTimeInput.value || '').trim();
    const seconds = parseTimestamp(raw);
    if (seconds === null) { showToast('Format: 1:24:35 or 84:35 or 245'); return; }
    socket.emit('netflix-time', { roomId: currentRoomId, currentTime: seconds });
    showToast(`Synced to ${raw}`);
  });
}

function parseTimestamp(str) {
  if (!str) return null;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// ── YouTube Player ─────────────────────────────────────────
function loadPlayerVideo(videoId) {
  playerPlaceholder.style.display = 'none';
  if (!playerReady) {
    pendingState = pendingState || {};
    pendingState.videoId = videoId;
    return;
  }
  if (role === 'listener') {
    listenerApplying = true;
    player.cueVideoById(videoId); // Listener cues — waits for host's 'play' event
    setTimeout(() => { listenerApplying = false; }, 600);
    updatePlayerBlocker();
  } else {
    suppressStateChange = true;
    player.loadVideoById(videoId);
    setTimeout(() => { suppressStateChange = false; }, 800);
  }
}

window.onYouTubeIframeAPIReady = function () {
  console.log('[YT] IFrame API ready');

  player = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: {
      playsinline:    1,
      rel:            1,
      modestbranding: 1,
      autoplay:       0,
      origin:         location.origin,
    },
    events: {
      onReady:       onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError:       onPlayerError,
    },
  });
};

function onPlayerReady() {
  console.log('[YT] player ready');
  playerReady = true;

  if (role === 'host') {
    const data = player.getVideoData && player.getVideoData();
    if (data && data.video_id) hostVideoId = data.video_id;
  }

  updatePlayerBlocker();

  if (pendingState && pendingState.videoId) {
    const state = pendingState;
    pendingState = null;

    if (role === 'listener') {
      listenerApplying = true;
      player.cueVideoById(state.videoId);
      setTimeout(() => {
        listenerApplying = false;
        if (state.currentTime > 0) {
          listenerApplying = true;
          player.seekTo(state.currentTime, true);
          setTimeout(() => { listenerApplying = false; }, 500);
        }
        if (state.isPlaying) {
          player.playVideo();
          setSyncStatus('synced', 'Playing · Synced');
        } else {
          setSyncStatus('synced', 'Paused · Synced');
        }
        updatePlayerBlocker();
      }, 1200);
    } else {
      suppressStateChange = true;
      player.loadVideoById(state.videoId);
      setTimeout(() => { suppressStateChange = false; }, 800);
    }
  }
}

// ── Player state change ────────────────────────────────────
function onPlayerStateChange(event) {
  const state = event.data;
  const YTS   = YT.PlayerState;

  // ── ENDED ────────────────────────────────────────────────
  // HOST:     DO NOT block. Let YouTube's 5-second countdown autoplay the next
  //           recommended video. The video-change detector below will pick up
  //           the new video ID and broadcast it to all listeners.
  // LISTENER: Block end-screen navigation cards (they would redirect to youtube.com).
  //           The blocker is removed when the host's next 'play' event arrives.
  if (state === YTS.ENDED) {
    if (role === 'host') {
      stopHeartbeat();
      if (!isPlaylistMode && hostVideoId) {
        // Load YouTube Radio for this song (RD + videoId).
        // YouTube Radio playlists are personalized — they use the viewer's
        // account and watch history to queue recommendations.
        // index:1 skips the seed track (track 0 = current song).
        setSyncStatus('waiting', 'Loading next recommendation…');
        isPlaylistMode = true;
        player.loadPlaylist({ listType: 'playlist', list: 'RD' + hostVideoId, index: 1 });
        showToast('YouTube Radio started — next song coming…');
      } else {
        setSyncStatus('waiting', 'Video ended');
      }
    } else {
      // Block listener's end-screen to prevent navigation to youtube.com
      if (syncMode !== 'soft') showPlayerBlocker(true);
      setSyncStatus('waiting', 'Video ended — waiting for host…');
    }
    return;
  }

  // ── LISTENER: soft-sync local pause / resume ─────────────
  if (role === 'listener') {
    if (listenerApplying) return;
    if (syncMode !== 'soft') return; // strict: overlay blocks all interactions

    if (state === YTS.PAUSED) {
      listenerLocalPaused = true;
      setSyncStatus('synced', 'Paused locally · Sync running');
    } else if (state === YTS.PLAYING && listenerLocalPaused) {
      listenerLocalPaused = false;
      setSyncStatus('resyncing', 'Catching up…');
    }
    return;
  }

  // ── HOST ─────────────────────────────────────────────────
  if (suppressStateChange) return;

  const currentTime = player.getCurrentTime();

  // Detect new video (YouTube autoplay / earphone next / playlist advance)
  const nowVideoId = player.getVideoData && player.getVideoData().video_id;
  if (nowVideoId && nowVideoId !== hostVideoId && state !== YTS.UNSTARTED) {
    console.log('[host] video changed:', hostVideoId, '→', nowVideoId);
    hostVideoId    = nowVideoId;
    isPlaylistMode = !!(player.getPlaylist && player.getPlaylist());
    pushToHistory(nowVideoId);
    socket.emit('load-video', { roomId: currentRoomId, videoId: nowVideoId });
    ytUrlInput.value = `https://www.youtube.com/watch?v=${nowVideoId}`;
    const title = player.getVideoData().title;
    updateNowPlaying(title || nowVideoId);
    if (window._refreshMediaMetadata) window._refreshMediaMetadata();
  }

  if (state === YTS.PLAYING) {
    if (seekCheckTime !== null) {
      const expectedTime = seekCheckTime.time + (Date.now() - seekCheckTime.at) / 1000;
      if (Math.abs(currentTime - expectedTime) > 1.5) {
        socket.emit('seek', { roomId: currentRoomId, currentTime });
      }
    }
    seekCheckTime = null;
    socket.emit('play', { roomId: currentRoomId, currentTime });
    startHeartbeat();
    setSyncStatus('synced', 'Playing · Broadcasting');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';

  } else if (state === YTS.PAUSED) {
    seekCheckTime = { time: currentTime, at: Date.now() };
    socket.emit('pause', { roomId: currentRoomId, currentTime });
    stopHeartbeat();
    setSyncStatus('synced', 'Paused · Broadcasting');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';

  } else if (state === YTS.BUFFERING) {
    setSyncStatus('resyncing', 'Buffering…');
  }
}

// ── Player error handler ───────────────────────────────────
function onPlayerError(event) {
  const code = event.data;
  // 101 / 150 = embedding disabled by video owner
  // 100       = video not found or private
  // 2         = invalid video ID
  if (code === 101 || code === 150) {
    showToast('❌ Embedding blocked by uploader — try a different video', 6000);
    setSyncStatus('waiting', 'Embedding disabled');
  } else if (code === 100) {
    showToast('❌ Video not found or set to private', 5000);
    setSyncStatus('waiting', 'Video unavailable');
  } else {
    showToast(`⚠️ Player error (code ${code})`, 4000);
    setSyncStatus('waiting', 'Playback error');
  }
}

// ── Heartbeat ──────────────────────────────────────────────
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (!playerReady || !currentRoomId) return;
    socket.emit('heartbeat', { roomId: currentRoomId, currentTime: player.getCurrentTime() });
  }, 2000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ── YouTube Search ─────────────────────────────────────────
const searchInput    = $('search-input');
const btnSearch      = $('btn-search');
const searchDropdown = $('search-dropdown');

let searchDebounce = null;

function closeSearchDropdown() {
  if (searchDropdown) searchDropdown.classList.remove('open');
}

function renderSearchResults(items) {
  if (!searchDropdown) return;
  if (!items.length) {
    searchDropdown.innerHTML = '<div class="search-loading">No results found.</div>';
  } else {
    searchDropdown.innerHTML = items.map(v => `
      <div class="search-result" data-id="${v.id}" data-title="${escapeHtml(v.title)}">
        <img src="${v.thumbnail}" loading="lazy" alt="" onerror="this.style.display='none'" />
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(v.title)}</div>
          <div class="search-result-meta">${escapeHtml(v.channel)}${v.duration ? ' · ' + v.duration : ''}</div>
        </div>
      </div>
    `).join('');

    searchDropdown.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const videoId = el.dataset.id;
        const title   = el.dataset.title;
        if (!videoId || role !== 'host') return;
        isPlaylistMode = false;
        loadAndBroadcastVideo(videoId);
        updateNowPlaying(title);
        ytUrlInput.value = `https://www.youtube.com/watch?v=${videoId}`;
        searchInput.value = title;
        closeSearchDropdown();
        showToast(`Loading: ${title}`);
      });
    });
  }
  searchDropdown.classList.add('open');
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function runSearch(q) {
  if (!q) return;
  if (searchDropdown) {
    searchDropdown.innerHTML = '<div class="search-loading">Searching…</div>';
    searchDropdown.classList.add('open');
  }
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSearchResults(data.items || []);
  } catch (e) {
    if (searchDropdown) {
      searchDropdown.innerHTML = '<div class="search-loading">Search failed. Try pasting a URL instead.</div>';
    }
  }
}

if (searchInput) {
  // Debounced live search as user types
  searchInput.addEventListener('input', () => {
    if (role !== 'host') return;
    const q = searchInput.value.trim();
    clearTimeout(searchDebounce);
    if (!q) { closeSearchDropdown(); return; }
    searchDebounce = setTimeout(() => runSearch(q), 400);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchDebounce);
      runSearch(searchInput.value.trim());
    }
    if (e.key === 'Escape') closeSearchDropdown();
  });
}

if (btnSearch) {
  btnSearch.addEventListener('click', () => {
    if (role !== 'host') return;
    clearTimeout(searchDebounce);
    runSearch(searchInput.value.trim());
  });
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (searchDropdown && !searchDropdown.contains(e.target) && e.target !== searchInput && e.target !== btnSearch) {
    closeSearchDropdown();
  }
});

// ── Chat ───────────────────────────────────────────────────

function formatChatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendChatMessage({ type, mine, displayName, role: msgRole, text, ts }) {
  if (!chatMessages) return;

  const isAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 40;

  const wrap = document.createElement('div');

  if (type === 'system') {
    wrap.className = 'chat-msg system';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
  } else {
    wrap.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;

    // Meta line: name + time
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const who = document.createElement('span');
    who.className = `who${msgRole === 'host' ? ' host-who' : ''}`;
    who.textContent = mine ? 'You' : displayName;
    const time = document.createElement('span');
    time.textContent = formatChatTime(ts);
    meta.appendChild(who);
    meta.appendChild(time);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = text;

    wrap.appendChild(meta);
    wrap.appendChild(bubble);
  }

  chatMessages.appendChild(wrap);

  // Auto-scroll if user was already at the bottom
  if (isAtBottom) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Unread badge when scrolled up (chat always visible in sidebar)
  if (!mine && type !== 'system' && !isAtBottom) {
    chatUnreadCount++;
    if (chatUnread) {
      chatUnread.textContent = chatUnreadCount;
      chatUnread.classList.add('has-unread');
    }
  }

  // Mobile: bump chat-toggle badge when chat panel is closed
  if (!mine && type !== 'system') {
    const chatCol = $('chat-col');
    const isMobileClosed = chatCol && !chatCol.classList.contains('open') &&
                           window.getComputedStyle(chatCol).height === '0px';
    if (isMobileClosed) {
      const badge = $('chat-toggle-badge');
      if (badge) {
        const n = (parseInt(badge.textContent) || 0) + 1;
        badge.textContent = n;
        badge.classList.add('show');
      }
    }
  }
}

function sendChatMessage() {
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text || !currentRoomId) return;
  socket.emit('chat-message', { roomId: currentRoomId, text });
  chatInput.value = '';
}

function clearUnread() {
  chatUnreadCount = 0;
  if (chatUnread) {
    chatUnread.textContent = '';
    chatUnread.classList.remove('has-unread');
  }
}

// Send on button click
if (btnChatSend) {
  btnChatSend.addEventListener('click', sendChatMessage);
}

// Send on Enter (Shift+Enter = newline — but input is single-line so just Enter sends)
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  // Clear unread when user focuses the input (they're reading chat)
  chatInput.addEventListener('focus', clearUnread);
}

// Clear unread when user focuses chat input
if (chatInput) {
  chatInput.addEventListener('focus', clearUnread);
}

// Clear unread when scrolled to bottom
if (chatMessages) {
  chatMessages.addEventListener('scroll', () => {
    const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 10;
    if (atBottom) clearUnread();
  });
}

// ── Mobile chat toggle ─────────────────────────────────────
const chatToggleBtn = $('chat-toggle');

if (chatToggleBtn) {
  chatToggleBtn.addEventListener('click', () => {
    const chatCol = $('chat-col');
    if (!chatCol) return;
    const isOpen = chatCol.classList.toggle('open');
    // Update button icon
    const badge = $('chat-toggle-badge');
    chatToggleBtn.childNodes[0].textContent = isOpen ? '✕' : '💬';
    if (isOpen) {
      // Clear mobile unread badge
      if (badge) { badge.textContent = ''; badge.classList.remove('show'); }
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  });
}

// ── Bootstrap ──────────────────────────────────────────────
// If we have a stored session, hide landing immediately so the user doesn't
// see a flash of the landing page during auto-rejoin after refresh.
(function preBootstrap() {
  const session = loadSession();
  if (session && session.roomId) {
    landingEl.style.display = 'none';
    roomEl.style.display    = 'flex';
    setSyncStatus('waiting', 'Reconnecting…');
  }
})();

// Warn before refresh so user knows they're about to leave
let skipUnloadWarning = false;
window.addEventListener('beforeunload', (e) => {
  if (currentRoomId && !skipUnloadWarning) {
    e.preventDefault();
    e.returnValue = 'You will leave the room.';
    return e.returnValue;
  }
});

// ── Logout / leave room ────────────────────────────────────
// Clears stored session and reloads to landing page so user can
// create / join a different room without fighting the auto-rejoin.
const btnLogout = $('btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', () => {
    if (!confirm('Leave this room?')) return;
    skipUnloadWarning = true;
    clearSession();
    try { socket.disconnect(); } catch (e) {}
    location.href = location.pathname; // reload to fresh landing
  });
}

initSocket();
