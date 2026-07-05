# Snake Survivor — Project Notes for Claude

**Last updated:** 2026-07-04
**Status:** Active development. v1.84 deployed. Classic mode was removed — every run is the Vampire-Survivors-style roguelite: choose a difficulty, choose a snake character (each seeds a different starting ability), eat to gain XP, level up, pick from a growing pool of abilities (22 so far).
**Rebrand note:** the game displays as "Snake Survivor" (title screen, page title, PWA manifest) as of this update. The GitHub repo, its URL, and the live Pages URL below are unchanged — still `Snakes` — since renaming those would risk breaking the live PWA scope/URL and wasn't part of the ask.

---

## What This Is

Browser-based Snake roguelite ("Snake Survivor"). Portrait mode. Bottom portion of the phone screen is a swipe zone. Every run starts with a pre-game flow: title screen -> choose difficulty (Easy/Normal) -> choose a snake character (one per ability, seeds that ability at level 1) -> game starts. From there it's an XP/level-up system (see `ABILITY_CFG` in `public/client.js`) — Sprint (hold) and Dash (tap) are the only two manually-triggered abilities (one per gesture slot, mutually exclusive with their slot-mates), everything else auto-triggers or is passive once picked. Anyone can play via a link — no install required. PWA-capable.

**GitHub:** https://github.com/VirtualSteveShow/Snakes (public — required for GitHub Pages; repo name unchanged by the rebrand)
**Hosting:** GitHub Pages, auto-deploys on `git push master` via `.github/workflows/pages.yml` — live at https://virtualsteveshow.github.io/Snakes/
**Alt hosting:** Render.com free tier — not set up, was the original plan before switching to GitHub Pages

---

## Port Map (Steven's local machine)

| Port | App |
|------|-----|
| 8080 | ComfyUI Phone App |
| 8081 | Meal Planner |
| 8082 | SpyFall |
| **8083** | **Snakes ← this project** |
| 8084 | OneHand (`C:\Projects\OneHand`) |

---

## Stack

- **Server:** Python + aiohttp (static file server)
- **Frontend:** Vanilla JS/HTML/CSS, single page app, canvas-based game
- **Hosting:** Render.com free tier — `$PORT` env var
- **Local SSL:** Tailscale cert (same as SpyFall and Phone App)
  - `C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.crt`
  - `C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.key`
- **PWA:** manifest.json + sw.js (network-first, offline fallback)

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

## Git Safety Rule

**Always commit before starting any significant editing session.** This ensures there's always a clean rollback point. If Claude Code runs out of usage mid-edit and leaves a file broken, run:
```
git checkout -- .
```
to restore everything to the last commit.

After every completed feature: `git add . && git commit -m "..." && git push`

---

## Versioning — bump ALL FOUR on every frontend deploy

| What | Where | Current value |
|------|-------|---------------|
| `const VERSION` | `public/client.js` line 3 | `'v1.84'` |
| stylesheet link | `public/index.html` `<link rel="stylesheet" href="style.css?v=N">` | `v84` |
| script tag | `public/index.html` `<script src="client.js?v=N">` | `v84` |
| SW cache key | `public/sw.js` `const CACHE` | `'snakes-v85'` |

**Note:** all asset paths in `index.html`, `manifest.json`, `sw.js`, and `client.js` must stay **relative** (no leading `/`) — GitHub Pages serves this repo from `/Snakes/`, not domain root.

---

## File Structure

```
Snakes/
├── server.py          — aiohttp static file server, port 8083 (local dev only)
├── requirements.txt   — aiohttp>=3.9.0
├── CLAUDE.md
├── TODO.md
├── Start_Server.bat
├── Restart_Server.bat
├── .github/workflows/pages.yml   — deploys public/ to GitHub Pages on push to master
└── public/
    ├── index.html     — game, all UI
    ├── style.css
    ├── client.js      — game loop, canvas, swipe, all game logic
    ├── sw.js          — service worker (network-first, cache fallback)
    ├── manifest.json  — PWA manifest
    ├── icons/         — PWA icons (192px + 512px)
    └── images/        — bg_grass.png, snake_scale.png, snake textures
```

---

## Snake Characters (planned — Advanced mode)

Each snake has a unique look and passive/active abilities. Classic mode uses the default green snake. Advanced mode lets the player choose their character before the round.

Planned characters (concept):
- **Green** (default) — Balanced. Passive: none. Active: Tongue lunge.
- More TBD

---

## Deploying

```
git add .
git commit -m "description"
git push
```

GitHub Pages auto-deploys in ~1–2 min via Actions. Always bump all four version markers before committing any frontend change.
