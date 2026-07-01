# Initial Prompt — Snake Project

Copy everything below this line into a new Claude session.

---

I want to build a browser-based Snake game. Here is everything you need to know to build it from scratch.

## What I want

A classic Snake game that runs in the browser as a PWA. Anyone can play via a link — no install required. It should work great on a phone in portrait mode.

## Stack

- **Server:** Python + aiohttp serving static files. Port 8083 locally, `$PORT` env var on Render.com.
- **Frontend:** Vanilla JS/HTML/CSS. Canvas-based game. No frameworks, no build step.
- **PWA:** manifest.json + sw.js so it can be added to the home screen.
- **Hosting:** Will deploy to Render.com (auto-deploy on git push). Start with local development.

## Local SSL

Use this Tailscale cert for HTTPS locally (same cert used by my other projects):
- `C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.crt`
- `C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.key`

Falls back to plain HTTP if cert is missing.

## Portrait Mode Layout

The screen is split into two zones:

```
┌─────────────────┐
│                 │
│   GAME CANVAS   │  ← Snake game (top ~70% of screen)
│                 │
├─────────────────┤
│                 │
│   SWIPE ZONE    │  ← bottom ~30% of screen
│  swipe to steer │
│                 │
└─────────────────┘
```

- Game canvas fills the top ~70% of the viewport, square or near-square
- Bottom ~30% is a dedicated swipe zone — user swipes here to change direction
- Swipe direction = up/down/left/right detected via touchstart/touchend delta
- Tapping the swipe zone does nothing — only a swipe counts
- Keyboard arrow keys also work for desktop testing
- Portrait orientation preferred (set in manifest if possible)

## Game Requirements

- Classic Snake: snake grows when it eats food, dies on wall collision or self collision
- Score at top — current score and high score (high score persisted in localStorage)
- Speed increases as the snake grows longer
- Food spawns randomly (never on the snake body)
- Game over screen shows final score with a Restart button
- Clean, simple color scheme readable on a phone screen

## File Structure

```
Snake/
├── server.py
├── requirements.txt       — aiohttp>=3.9.0
├── Start_Server.bat       — kills port 8083, starts server, prints local URLs
├── Restart_Server.bat
└── public/
    ├── index.html
    ├── style.css
    ├── client.js
    ├── sw.js
    ├── manifest.json
    └── icons/             — 192px + 512px PWA icons (placeholder ok for now)
```

## Versioning

Add version cache-busting from day one — I've been burned by stale files before:
- `const VERSION = 'v1.00'` at top of client.js
- `<link rel="stylesheet" href="style.css?v=100">` in index.html
- `<script src="client.js?v=100">` in index.html
- `const CACHE = 'snake-v100'` in sw.js

All four must be bumped together on every frontend change.

## Start_Server.bat

Should kill any existing process on port 8083, start server.py, and print the local HTTPS URL and the Tailscale URL for phone testing:
- `https://localhost:8083`
- `https://desktop-rsghbik.tail60e4a8.ts.net:8083`

## What to build first

Build a working game end-to-end in one shot:
1. server.py (static file server, SSL, port 8083)
2. All public/ files (index.html, style.css, client.js, sw.js, manifest.json)
3. Start_Server.bat and Restart_Server.bat
4. requirements.txt

The game should be fully playable on first run. After building, tell me how to test it.
