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

// ---------- GitHub backup (survives redeploys/sleeps on free-tier ephemeral disk) ----------
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = 'dimkadimon/Mine-Star';
const GH_BRANCH = 'scores-backup';
const GH_PATH = 'data/scores.json';
const backupState = { enabled: !!GH_TOKEN, lastOk: null, lastError: null, inFlight: false, dirty: false };

function mergeScores(a, b) {
  const out = {};
  const hintsOf = (e) => (Number.isFinite(e.hints) ? e.hints : 999);
  for (const s of VALID_SIZES) {
    const seen = new Map();
    for (const e of [...((a && a[s]) || []), ...((b && b[s]) || [])]) {
      if (e && e.id && !seen.has(e.id)) seen.set(e.id, e);
    }
    out[s] = [...seen.values()]
      .filter((e) => Number.isFinite(Number(e.time)))
      .sort((x, y) => x.time - y.time || hintsOf(x) - hintsOf(y))
      .slice(0, 200);
  }
  return out;
}

async function ghGetFile() {
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`, {
    headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'mine-star-server' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gh get ${res.status}`);
  return res.json();
}

async function restoreFromGitHub() {
  if (!GH_TOKEN) return;
  try {
    const file = await ghGetFile();
    if (!file) { console.log('No GitHub backup yet, starting from local seed'); return; }
    const remote = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    const merged = mergeScores(readScores(), remote);
    writeScores(merged);
    console.log('Restored scores from GitHub backup branch');
  } catch (e) {
    console.log('GitHub restore skipped:', e.message);
  }
}

async function backupToGitHub() {
  if (!GH_TOKEN) return;
  if (backupState.inFlight) { backupState.dirty = true; return; }
  backupState.inFlight = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await ghGetFile();
        const remote = file ? JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) : null;
        const merged = mergeScores(readScores(), remote || {});
        const body = Buffer.from(JSON.stringify(merged, null, 2)).toString('base64');
        const payload = {
          message: `chore: backup global scores ${new Date().toISOString()}`,
          content: body,
          branch: GH_BRANCH,
        };
        if (file) payload.sha = file.sha;
        const put = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'mine-star-server' },
          body: JSON.stringify(payload),
        });
        if (put.status === 409 || put.status === 422) continue; // sha raced, retry
        if (!put.ok) throw new Error(`gh put ${put.status}`);
        writeScores(merged);
        backupState.lastOk = new Date().toISOString();
        backupState.lastError = null;
        break;
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
  } catch (e) {
    backupState.lastError = `${new Date().toISOString()}: ${e.message}`;
    console.error('GitHub backup failed:', e.message);
  } finally {
    backupState.inFlight = false;
    if (backupState.dirty) { backupState.dirty = false; backupToGitHub(); }
  }
}

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30d',
  immutable: true,
  setHeaders: (res, filePath) => {
    // HTML is never cached, so versioned asset URLs are picked up immediately
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

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
  backupToGitHub();
  const rank = all[cleanSize].findIndex((e) => e.id === entry.id) + 1;
  res.status(201).json({ ...entry, rank });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    backup: { enabled: backupState.enabled, lastOk: backupState.lastOk, lastError: backupState.lastError },
  });
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
      backupToGitHub();
      return res.json(e);
    }
  }
  res.status(404).json({ error: 'Not found.' });
});

app.delete('/api/scores/:id', (req, res) => {
  // Moderation endpoint — guarded by the server-side backup token.
  if (!GH_TOKEN || req.query.token !== GH_TOKEN) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const { id } = req.params;
  const all = readScores();
  for (const size of VALID_SIZES) {
    const ix = (all[size] || []).findIndex((x) => x.id === id);
    if (ix >= 0) {
      const [gone] = all[size].splice(ix, 1);
      writeScores(all);
      backupToGitHub();
      return res.json({ deleted: gone });
    }
  }
  res.status(404).json({ error: 'Not found.' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureStore();
// Pull any scores that landed after this image was built (e.g. wiped by a
// redeploy), then start serving.
restoreFromGitHub()
  .catch(() => {})
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`⭐ Mine Star running on port ${PORT}`);
    });
  });
