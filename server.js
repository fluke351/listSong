// LAN music queue — plays YouTube audio downloaded on this machine (no YouTube player = no ads)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.PORT) || 3100;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PREFETCH = 3; // download current + next N songs ahead of time
const MAX_HISTORY = 30;
// cache limit for songs that already played; songs playing or in the queue are always kept. 0 = delete right after playing
const CACHE_MAX_MB = Math.max(0, Number(process.env.CACHE_MAX_MB ?? 500) || 0);
const AUDIO_EXT = ['m4a', 'webm', 'mp4', 'opus', 'mp3', 'ogg', 'aac'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.aac': 'audio/aac',
};

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function findYtDlp() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const local = path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return fs.existsSync(local) ? local : 'yt-dlp';
}
const YTDLP = findYtDlp();
// newer yt-dlp needs a JavaScript runtime for YouTube; hand it the node.exe that runs this server
const YTDLP_VERSION = (spawnSync(YTDLP, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const YTDLP_BASE_ARGS = YTDLP_VERSION >= '2025.11' ? ['--js-runtimes', `node:${process.execPath}`] : [];

// ---------- state ----------
let state = { current: null, queue: [], history: [], paused: false, volume: 0.8 };
let progress = null; // { uid, time, duration }

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...saved };
    for (const it of allItems()) {
      const file = findCached(it.videoId);
      if (file) Object.assign(it, { status: 'ready', file });
      else if (it.status !== 'error') Object.assign(it, { status: 'pending', file: null });
      if (!it.title || it.meta === 'loading') it.meta = null;
    }
  } catch { /* first run */ }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1), () => {});
  }, 300);
}

function allItems() {
  return [state.current, ...state.queue].filter(Boolean);
}
function findItem(uid) {
  return allItems().find((it) => it.uid === uid);
}

// ---------- server-sent events ----------
const clients = new Set();
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}
function changed() {
  pump(); // never calls changed() synchronously, so no recursion
  saveState();
  broadcast('state', state);
}

// ---------- yt-dlp ----------
function parseYouTubeId(input) {
  input = String(input || '').trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (['youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[2];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

function runYtDlp(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(YTDLP, [...YTDLP_BASE_ARGS, ...args], { windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    // decode as a stream so Thai characters split across chunks aren't mangled
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'ไม่พบ yt-dlp บนเครื่องเซิร์ฟเวอร์' : e.message));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const line = err.split(/\r?\n/).filter((l) => l.startsWith('ERROR')).pop() || err.trim().split(/\r?\n/).pop();
      reject(new Error((line || `yt-dlp exited with code ${code}`).replace(/^ERROR:\s*/, '').slice(0, 300)));
    });
  });
}

function limiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    next();
  });
}
const metaLimit = limiter(3);
const downloadLimit = limiter(2);
const searchLimit = limiter(2);

function findCached(videoId) {
  const re = new RegExp(`^${videoId}\\.(${AUDIO_EXT.join('|')})$`);
  return fs.readdirSync(CACHE_DIR).find((f) => re.test(f)) || null;
}

const metaCache = new Map();
function fetchMeta(videoId) {
  if (!metaCache.has(videoId)) {
    const p = metaLimit(() => runYtDlp(
      ['-J', '--no-playlist', '--skip-download', '--no-warnings', '--', `https://www.youtube.com/watch?v=${videoId}`],
      60 * 1000,
    )).then((out) => {
      const j = JSON.parse(out);
      return { title: j.title, channel: j.channel || j.uploader || '', duration: j.duration || 0 };
    });
    p.catch(() => metaCache.delete(videoId));
    metaCache.set(videoId, p);
  }
  return metaCache.get(videoId);
}

const searchCache = new Map(); // query -> { at, results }
async function searchYouTube(query) {
  const key = query.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.results;
  const out = await searchLimit(() => runYtDlp(
    ['--flat-playlist', '-J', '--no-warnings', '--', `ytsearch15:${query}`],
    30 * 1000,
  ));
  const results = (JSON.parse(out).entries || [])
    // skip live streams / premieres (no duration) — they can't be downloaded as a song
    .filter((e) => /^[\w-]{11}$/.test(e.id || '') && e.duration > 0 && e.live_status !== 'is_live')
    .map((e) => ({ videoId: e.id, title: e.title || '', channel: e.channel || e.uploader || '', duration: e.duration }));
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(key, { at: Date.now(), results });
  return results;
}

const downloads = new Map();
function downloadAudio(videoId) {
  const cached = findCached(videoId);
  if (cached) return Promise.resolve(cached);
  if (!downloads.has(videoId)) {
    const p = downloadLimit(() => runYtDlp([
      '--no-playlist', '--no-progress', '--no-warnings', '--no-mtime',
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '-o', path.join(CACHE_DIR, '%(id)s.%(ext)s'),
      '--', `https://www.youtube.com/watch?v=${videoId}`,
    ])).then(() => {
      const file = findCached(videoId);
      if (!file) throw new Error('ดาวน์โหลดไม่สำเร็จ');
      return file;
    }).finally(() => downloads.delete(videoId));
    downloads.set(videoId, p);
  }
  return downloads.get(videoId);
}

// ---------- cache cleanup ----------
let cacheInfo = { usedMB: 0, maxMB: CACHE_MAX_MB, files: 0 };

function touchCached(videoId) {
  const file = findCached(videoId);
  if (file) try { fs.utimesSync(path.join(CACHE_DIR, file), new Date(), new Date()); } catch { /* ignore */ }
}

// mtime = last time a song was queued/played, so the least recently used songs go first
function cleanCache() {
  const keep = new Set([...allItems().map((it) => it.videoId), ...downloads.keys()]);
  const audioRe = new RegExp(`^[\\w-]{11}\\.(${AUDIO_EXT.join('|')})$`);
  const files = [];
  for (const name of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const videoId = name.slice(0, 11);
    if (!audioRe.test(name)) {
      // leftovers from an interrupted or failed download
      if (!downloads.has(videoId)) try { fs.unlinkSync(full); } catch { /* still open, retry later */ }
      continue;
    }
    files.push({ full, videoId, size: st.size, mtime: st.mtimeMs });
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  const limit = CACHE_MAX_MB * 1024 * 1024;
  for (const f of files.filter((f) => !keep.has(f.videoId)).sort((a, b) => a.mtime - b.mtime)) {
    if (total <= limit) break;
    try {
      fs.unlinkSync(f.full);
      total -= f.size;
    } catch { /* file still being streamed (Windows locks it), retry later */ }
  }
  const remaining = fs.readdirSync(CACHE_DIR).filter((n) => audioRe.test(n)).length;
  cacheInfo = { usedMB: Math.round(total / 1048576), maxMB: CACHE_MAX_MB, files: remaining };
  broadcast('cache', cacheInfo);
}

let cleanTimer = null;
function scheduleClean() {
  cleanCache();
  clearTimeout(cleanTimer);
  cleanTimer = setTimeout(cleanCache, 15000); // second pass once the browser has released the last song
}

function markError(videoId, message) {
  for (const it of allItems()) {
    if (it.videoId === videoId && it.status !== 'ready') Object.assign(it, { status: 'error', error: message });
  }
  if (state.current && state.current.status === 'error') advance();
  else changed();
}

// start metadata lookups for everything and downloads for the next few songs
function pump() {
  for (const it of allItems()) {
    if (it.meta) continue;
    it.meta = 'loading';
    fetchMeta(it.videoId).then((m) => {
      for (const x of allItems()) if (x.videoId === it.videoId) Object.assign(x, m, { meta: 'done' });
      changed();
    }, (e) => {
      it.meta = 'failed';
      markError(it.videoId, e.message);
    });
  }
  const window = [state.current, ...state.queue.slice(0, PREFETCH)].filter(Boolean);
  for (const it of window) {
    if (it.status !== 'pending') continue;
    it.status = 'downloading';
    downloadAudio(it.videoId).then((file) => {
      for (const x of allItems()) if (x.videoId === it.videoId) Object.assign(x, { status: 'ready', file, error: null });
      changed();
      scheduleClean();
    }, (e) => {
      markError(it.videoId, e.message);
      scheduleClean();
    });
  }
}

// ---------- queue actions ----------
function advance() {
  if (state.current) {
    const { uid, videoId, title, channel, duration, addedBy } = state.current;
    state.history.unshift({ uid, videoId, title, channel, duration, addedBy, playedAt: Date.now() });
    state.history.length = Math.min(state.history.length, MAX_HISTORY);
  }
  state.current = null;
  while (state.queue.length) {
    const next = state.queue.shift();
    if (next.status !== 'error') {
      state.current = next;
      break;
    }
  }
  state.paused = false;
  progress = null;
  if (state.current) touchCached(state.current.videoId);
  changed();
  scheduleClean();
}

// hint = title/channel/duration from search results, shown until yt-dlp metadata arrives
function addSong(videoId, addedBy, hint = {}) {
  const item = {
    uid: crypto.randomBytes(6).toString('hex'),
    videoId,
    title: String(hint.title || '').slice(0, 300),
    channel: String(hint.channel || '').slice(0, 100),
    duration: Number(hint.duration) || 0,
    addedBy: String(addedBy || '').trim().slice(0, 30) || 'ไม่ระบุชื่อ',
    addedAt: Date.now(),
    status: findCached(videoId) ? 'ready' : 'pending',
    file: findCached(videoId),
    meta: null,
    error: null,
  };
  touchCached(videoId);
  if (!state.current) state.current = item;
  else state.queue.push(item);
  changed();
  return item;
}

// ---------- http ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

const routes = {
  'GET /api/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    send(res, 'state', state);
    if (progress) send(res, 'progress', progress);
    send(res, 'cache', cacheInfo);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  },
  'GET /api/info': (req, res) => json(res, 200, { urls: lanUrls() }),
  'GET /api/search': async (req, res) => {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(res, 400, { error: 'พิมพ์คำค้นหาก่อน' });
    try {
      json(res, 200, { results: await searchYouTube(q) });
    } catch (e) {
      json(res, 502, { error: 'ค้นหาไม่สำเร็จ: ' + e.message });
    }
  },
  'POST /api/add': async (req, res) => {
    const body = await readJson(req);
    const videoId = parseYouTubeId(body.url);
    if (!videoId) return json(res, 400, { error: 'ลิงก์ไม่ถูกต้อง — ต้องเป็นลิงก์วิดีโอ YouTube' });
    const dup = allItems().find((it) => it.videoId === videoId);
    if (dup) {
      const where = dup === state.current ? 'กำลังเล่นอยู่' : `อยู่ในคิวลำดับที่ ${state.queue.indexOf(dup) + 1} แล้ว`;
      return json(res, 409, { error: `เพลงนี้${where}` });
    }
    json(res, 200, addSong(videoId, body.name, body.hint));
  },
  'POST /api/remove': async (req, res) => {
    const { uid } = await readJson(req);
    state.queue = state.queue.filter((it) => it.uid !== uid);
    changed();
    scheduleClean();
    json(res, 200, { ok: true });
  },
  'POST /api/move': async (req, res) => {
    const { uid, to } = await readJson(req); // to: 'up' | 'down' | 'top'
    const i = state.queue.findIndex((it) => it.uid === uid);
    if (i >= 0) {
      const [it] = state.queue.splice(i, 1);
      const j = to === 'top' ? 0 : to === 'up' ? Math.max(0, i - 1) : Math.min(state.queue.length, i + 1);
      state.queue.splice(j, 0, it);
      changed();
    }
    json(res, 200, { ok: true });
  },
  // uid guard: a double-click or two player tabs can't skip two songs
  'POST /api/skip': async (req, res) => {
    const { uid } = await readJson(req);
    if (state.current && (!uid || state.current.uid === uid)) advance();
    json(res, 200, { ok: true });
  },
  'POST /api/ended': async (req, res) => {
    const { uid } = await readJson(req);
    if (state.current && state.current.uid === uid) advance();
    json(res, 200, { ok: true });
  },
  'POST /api/pause': async (req, res) => {
    const { paused } = await readJson(req);
    state.paused = !!paused;
    changed();
    json(res, 200, { ok: true });
  },
  'POST /api/volume': async (req, res) => {
    const { volume } = await readJson(req);
    state.volume = Math.min(1, Math.max(0, Number(volume) || 0));
    changed();
    json(res, 200, { ok: true });
  },
  'POST /api/progress': async (req, res) => {
    const { uid, time, duration } = await readJson(req);
    if (state.current && state.current.uid === uid) {
      progress = { uid, time: Number(time) || 0, duration: Number(duration) || 0 };
      broadcast('progress', progress);
    }
    json(res, 200, { ok: true });
  },
  'POST /api/clear': async (req, res) => {
    state.queue = [];
    changed();
    scheduleClean();
    json(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route) return await route(req, res);
    if (req.method !== 'GET') return json(res, 404, { error: 'not found' });

    const media = url.pathname.match(/^\/media\/([\w-]{11}\.[a-z0-9]{2,4})$/);
    if (media) return serveFile(req, res, path.join(CACHE_DIR, media[1]), true);

    const page = url.pathname === '/' || url.pathname === '/player' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, path.normalize(page));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'not found' });
    serveFile(req, res, file, false);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
  }
});

const PLAYER_URL = `http://127.0.0.1:${PORT}/player`;
function openBrowser() {
  if (process.env.OPEN_BROWSER !== '1' || process.platform !== 'win32') return;
  spawn('cmd', ['/c', 'start', '', PLAYER_URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // double-clicked start.bat again: the program is already running, just show it
  console.log(`\n  พอร์ต ${PORT} ถูกใช้อยู่ — โปรแกรมอาจเปิดอยู่แล้ว กำลังเปิดหน้าเว็บให้...`);
  console.log('  (ถ้าหน้าเว็บที่เปิดขึ้นมาไม่ใช่คิวเพลง แปลว่ามีโปรแกรมอื่นใช้พอร์ตนี้อยู่ ให้ปิดโปรแกรมนั้นก่อน)\n');
  openBrowser();
  setTimeout(() => process.exit(0), 2500); // not an error: the window just closes after showing the page
});

loadState();
server.listen(PORT, '0.0.0.0', () => {
  openBrowser();
  console.log('\n  🎵 คิวเพลง YouTube (ไม่มีโฆษณา) พร้อมใช้งาน\n');
  console.log(`  เครื่องลำโพง (เปิดที่เครื่องนี้):  ${PLAYER_URL}`);
  console.log('  ให้คนในวง LAN เปิด:');
  for (const u of lanUrls()) console.log(`     ${u}`);
  console.log(`\n  yt-dlp: ${YTDLP} ${YTDLP_VERSION || '(ไม่พบ! ลองเปิด start.bat ใหม่)'}`);
  console.log(`  แคชเพลงที่เล่นแล้ว: เก็บไม่เกิน ${CACHE_MAX_MB} MB (ลบเก่าสุดก่อนอัตโนมัติ)\n`);
  changed();
  cleanCache();
});
