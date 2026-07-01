# Snake — Project Notes for Claude

**Last updated:** 2026-06-29
**Status:** Not yet started. Folder created. Use INITIAL_PROMPT.md to kick off a new Claude session.

---

## What This Is

Browser-based Snake game. Portrait mode. Bottom portion of the phone screen is a swipe zone for controlling direction. Anyone can play via a link — no install required. PWA so it can be added to the home screen.

**Hosting:** Render.com (same as SpyFall — auto-deploys on `git push master`)
**GitHub:** TBD — create repo at github.com/VirtualSteveShow/Snake

---

## Port Map (Steven's local machine)

| Port | App |
|------|-----|
| 8080 | ComfyUI Phone App |
| 8081 | Meal Planner |
| 8082 | SpyFall |
| **8083** | **Snake ← this project** |

---

## Stack (mirror SpyFall exactly)

- **Server:** Python + aiohttp (static file server + optional WebSocket for future multiplayer)
- **Frontend:** Vanilla JS/HTML/CSS, single page app, canvas-based game
- **Hosting:** Render.com free tier — `$PORT` env var, no SSL needed there
- **Local SSL:** Tailscale cert (same one used by SpyFall and Phone App)
  - `C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.crt`
  - `C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.key`
- **PWA:** manifest.json + sw.js (cache-first for offline play)

---

## Local Development

```
Start_Server.bat   — kills existing on port 8083, starts fresh
python server.py   — run directly
```

URLs:
```
https://localhost:8083
https://desktop-rsghbik.tail60e4a8.ts.net:8083   — phone testing via Tailscale
```

---

## Layout (Portrait Mode)

```
┌─────────────────┐
│                 │
│   GAME CANVAS   │  ← Snake game, square or near-square
│                 │
│   (top ~70%)    │
│                 │
├─────────────────┤
│                 │
│   SWIPE ZONE    │  ← bottom ~30% of screen
│  ↑ ↓ ← →       │     touch/swipe to change direction
│                 │
└─────────────────┘
```

- Game canvas fills top 70% of viewport
- Swipe zone fills bottom 30% — visual indicator (arrows or text)
- Swipe gesture detected via touchstart/touchend delta
- Tap swipe zone = no action (only swipe counts)
- Keyboard arrow keys also work (desktop)

---

## Game Requirements

- Classic Snake mechanics: snake grows on eating food, dies on wall or self collision
- Portrait mode only (lock orientation if possible via manifest)
- Score displayed at top (current score + high score, persisted in localStorage)
- Speed increases as snake grows
- Food spawns randomly (not on snake body)
- Game over screen with score + restart button
- Simple color scheme — clean, readable on phone

## Nice to Have (do after basics work)

- [ ] Touch sensitivity tuning (swipe threshold)
- [ ] Difficulty selector (slow / normal / fast starting speed)
- [ ] Sound effects (eat, die) — simple beeps via Web Audio API, toggle-able
- [ ] Leaderboard (localStorage top 5 scores with initials)
- [ ] Snake skin color options

---

## File Structure (target)

```
Snake/
├── server.py          — aiohttp static file server, port 8083
├── requirements.txt   — aiohttp>=3.9.0
├── Start_Server.bat
├── Restart_Server.bat
└── public/
    ├── index.html     — game, all UI
    ├── style.css
    ├── client.js      — game loop, canvas, swipe detection
    ├── sw.js          — service worker
    ├── manifest.json  — PWA manifest
    └── icons/         — PWA icons (192px + 512px)
```

---

## Versioning

Same pattern as SpyFall — bump these on every frontend deploy:

| What | Where |
|------|-------|
| `const VERSION` | `public/client.js` line ~3 |
| stylesheet link | `public/index.html` `<link rel="stylesheet" href="style.css?v=N">` |
| script tag | `public/index.html` `<script src="client.js?v=N">` |
| SW cache key | `public/sw.js` `const CACHE` |

---

## Deploying

```
git add .
git commit -m "description"
git push
```

Render auto-deploys in ~1–2 min. Always bump version markers before committing any frontend change.
