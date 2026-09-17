# ⭐ Mine Star

A polished **Minesweeper with a twist**: two mine types — **🟠 normal mines (1pt)** and **💜 heavy mines (2pts)**. Numbers show the **sum of mine points** in neighboring cells. Flag every mine with the **correct type** and clear all safe sectors in the fastest time.

Play it live: **https://mine-star.onrender.com**

## Features

- 🛰🚀🌌 **3 board sizes** — Small 9×9 (8+4 mines), Medium 16×16 (30+15), Large 30×16 (66+33)
- 🚩💜 **Two flag types** — right-click / long-press cycles Normal → Heavy → clear (keys `1`/`2`/`F`)
- ⚡ **Chording** — click a satisfied number to blast open neighbors
- 💡 **Hints** — highlight a safe sector (+5s each); hint count is saved with your time
- ✨ Juicy feedback: particles, screen shake, confetti, procedural sound
- ⌨️ Full keyboard play (arrows/WASD + Space, F, C, H, R, P) · 📱 touch with single-tap flags, double-tap scan + Dig/Flag mode buttons
- ⏸ Pause, 💥 game-over + 🏆 win screens with **instant restart (R)**
- 🏆 **Local leaderboard** (per size, in-browser) + 🌍 **global leaderboard** (server API) — ranked by fastest time, hints shown
- 🌌 Animated starfield, 60fps canvas FX, responsive + reduced-motion support

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## API

- `GET /api/scores?size=small|medium|large&limit=20` — top scores by fastest time
- `POST /api/scores` — `{ name, size, time, hints }`
- `PATCH /api/scores/:id` — `{ name }` (rename within 15 min)
- `GET /api/health` — health check

## Deploy (Render)

This repo includes `render.yaml` — create a **Blueprint** from the repo, or a Web Service with:

- Build: `npm install` · Start: `npm start` · Health check: `/api/health`

## Controls

| Action | Mouse / Touch | Keyboard |
|---|---|---|
| Scan | Click / Double-tap | Space / Enter |
| Flag cycle | Right-click / Single-tap | F |
| Flag 1pt / 2pt | Mode buttons | 1 / 2 |
| Chord | Click revealed number | C |
| Hint (+5s) | 💡 Hint button | H |
| Pause | ⏸ button | P / Esc |
| Restart | ↻ button | R |
| Sound | 🔊 button | M |
