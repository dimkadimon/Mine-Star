const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const VALID_SIZES = ['small', 'medium', 'large'];

function ensureStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SCORES_FILE)) {
      fs.writeFileSync(SCORES_FILE, JSON.stringify({ small: [], medium: [], large: [] }, null, 2));
    } else {
      // Validate shape, repair if needed
      const raw = fs.readFileSync(SCORES_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      for (const s of VALID_SIZES) {
        if (!Array.isArray(parsed[s])) parsed[s] = [];
      }
      fs.writeFileSync(SCORES_FILE, JSON.stringify(parsed, null, 2));
    }
  } catch (e) {
    console.error('Score store init failed, using memory fallback:', e.message);
  }
}

let memoryFallback = { small: [], medium: [], large: [] };

function readScores() {
  try {
    const raw = fs.readFileSync(SCORES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const s of VALID_SIZES) {
      if (!Array.isArray(parsed[s])) parsed[s] = [];
    }
    return parsed;
  } catch (e) {
    return memoryFallback;
  }
}

function writeScores(data) {
  memoryFallback = data;
  try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to persist scores:', e.message);
  }
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Pilot';
  let n = name.trim().replace(/\s+/g, ' ').slice(0, 14);
  if (!n) return 'Pilot';
  // Strip control chars and angle brackets to keep it safe
  n = n.replace(/[<>\/\\{}]/g, '').trim();
  return n || 'Pilot';
}

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ---- API ----
app.get('/api/scores', (req, res) => {
  const size = String(req.query.size || 'small').toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 100);
  if (!VALID_SIZES.includes(size)) {
    return res.status(400).json({ error: 'Invalid size. Use small, medium or large.' });
  }
  const all = readScores();
  const hintsOf = (e) => (Number.isFinite(e.hints) ? e.hints : 999);
  const list = [...(all[size] || [])]
    .sort((a, b) => a.time - b.time || hintsOf(a) - hintsOf(b))
    .slice(0, limit);
  res.json({ size, scores: list });
});

app.post('/api/scores', (req, res) => {
  const { name, size, time, score, hints } = req.body || {};
  const cleanSize = String(size || '').toLowerCase();
  if (!VALID_SIZES.includes(cleanSize)) {
    return res.status(400).json({ error: 'Invalid size.' });
  }
  const t = Number(time);
  if (!Number.isFinite(t) || t <= 0 || t > 86400) {
    return res.status(400).json({ error: 'Invalid time.' });
  }
  // score is legacy/optional (kept so old clients keep working); hints is tracked now
  const s = Number(score);
  const h = Number(hints);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: sanitizeName(name),
    size: cleanSize,
    time: Math.round(t * 10) / 10,
    score: Number.isFinite(s) && s >= 0 ? Math.round(s) : 0,
    hints: Number.isFinite(h) && h >= 0 ? Math.min(999, Math.floor(h)) : null,
    date: new Date().toISOString()
  };
  const all = readScores();
  all[cleanSize].push(entry);
  const hintsOf = (e) => (Number.isFinite(e.hints) ? e.hints : 999);
  all[cleanSize] = all[cleanSize]
    .sort((a, b) => a.time - b.time || hintsOf(a) - hintsOf(b))
    .slice(0, 200);
  writeScores(all);
  const rank = all[cleanSize].findIndex((e) => e.id === entry.id) + 1;
  res.status(201).json({ ...entry, rank });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.patch('/api/scores/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const all = readScores();
  for (const size of VALID_SIZES) {
    const e = (all[size] || []).find((x) => x.id === id);
    if (e) {
      const age = Date.now() - Date.parse(e.date || 0);
      if (!Number.isFinite(age) || age > 15 * 60 * 1000) {
        return res.status(403).json({ error: 'Rename window expired.' });
      }
      e.name = sanitizeName(name);
      writeScores(all);
      return res.json(e);
    }
  }
  res.status(404).json({ error: 'Not found.' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureStore();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⭐ Mine Star running on port ${PORT}`);
});
