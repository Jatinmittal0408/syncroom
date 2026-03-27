# SyncRoom 🎵

A real-time YouTube sync app — watch and listen to the same video in perfect sync with friends, no matter where they are.

![Node.js](https://img.shields.io/badge/Node.js-22.x-green) ![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-black) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **Perfect sync** — host controls playback, listeners mirror in real-time with drift correction
- **Password-protected rooms** — private rooms with unique IDs
- **YouTube search** — search and load videos directly from the app
- **Autoplay / Radio** — when a video ends, YouTube Radio starts automatically
- **Prev / Next** — navigate playlist or video history
- **Voice chat** — bidirectional p2p audio via WebRTC (no server relay)
- **Live chat** — real-time text chat with display names
- **Sync modes** — Strict (host controls everything) or Soft (listeners can pause locally)
- **Host switching** — listener can request host control, host approves/rejects
- **Netflix mode** — manual timestamp sync for Netflix or any external platform
- **Earphone controls** — play/pause/next/prev via headphone buttons (Media Session API)
- **Responsive UI** — works on mobile and desktop

---

## How It Works

```
Host loads a video → all listeners load the same video
Host plays/pauses/seeks → server broadcasts to all listeners instantly
Every 2s, host sends a heartbeat → listeners correct any drift > 1 second
Voice chat goes peer-to-peer (WebRTC) → zero server load for audio
```

---

## Getting Started (Local)

```bash
git clone https://github.com/Jatinmittal0408/syncroom.git
cd syncroom
npm install
npm start
```

Open `http://localhost:3000` in two tabs to test.

---

## Usage

1. **Host** — enter a room name + password → click **Create Room** → paste a YouTube URL or search → click **Load**
2. **Listener** — enter the same room name + password → click **Join Room** → video loads and syncs automatically

### Testing across devices (same network)
Replace `localhost` with your machine's local IP (e.g. `192.168.1.x:3000`)

---

## Deployment

Live at: **https://syncroom-cbaw.onrender.com**

Deployed on [Render](https://render.com) free tier.

To deploy your own instance:
1. Fork this repo
2. Go to [render.com](https://render.com) → New Web Service → connect your fork
3. Build command: `npm install` · Start command: `npm start`

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Server | Node.js + Express |
| Real-time sync | Socket.IO |
| Voice chat | WebRTC (p2p) |
| Video player | YouTube IFrame API |
| Security | Helmet, express-rate-limit, SHA-256 passwords |
| Frontend | Vanilla JS (no build step) |

---

## Security

- Room passwords hashed with SHA-256
- Rate limiting: 120 req/min global, 30 req/min on search
- Brute-force protection: 5 password attempts per socket
- Helmet CSP headers block cross-origin scripts
- WebSocket connections restricted to same origin

---

## License

MIT
