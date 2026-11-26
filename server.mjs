// Локальний сервер помічника розмови. Без залежностей, Node 18+.
// Робить дві речі: віддає сторінку з public/ і передає звук (WAV) у розпізнавання мови.
// Логіка болей/заперечень працює в браузері (public/engine.js), ШІ не використовується.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');

// ---------- .env ----------
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env не обов'язковий */ }
const env = (k, d = '') => (process.env[k] ?? d);

const PORT = +env('PORT', '8443');
const LOCAL_PORT = +env('LOCAL_PORT', '8080');
const STT_PROVIDER = env('STT_PROVIDER', 'local');             // local | groq | custom
const STT_LANGUAGE = env('STT_LANGUAGE', 'uk');
const WHISPER_URL = env('WHISPER_URL', 'http://127.0.0.1:8178').replace(/\/$/, '');
const STT_URL = env('STT_URL');                                  // custom: OpenAI-сумісний /audio/transcriptions
const STT_KEY = env('STT_KEY') || env('GROQ_API_KEY');
const STT_MODEL = env('STT_MODEL', 'whisper-large-v3-turbo');
const MAX_BODY = 6 * 1024 * 1024;

// ---------- розпізнавання ----------
const HALLU = /(дякую за перегляд|дякуємо за перегляд|спасибо за просмотр|субтитри|субтитры|редактор субтитр|корректор|підписуйтесь|подписывайтесь|продовження буде|продолжение следует|thanks for watching|thank you for watching|amara\.org|dimatorzok|сделано\s+с\s+помощью)/i;

function clean(text) {
  let t = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();   // [музика], (сміх)
  if (t.length < 2 || !/[a-zа-яіїєґ]/i.test(t)) return '';
  if (HALLU.test(t)) return '';
  t = t.replace(/\b(\S{1,12})(?:[\s,.!?-]+\1\b){4,}/gi, '$1');                                       // зациклення «так так так так»
  return t;
}

function wavForm(buf, extra = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'chunk.wav');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

async function transcribe(buf) {
  if (STT_PROVIDER === 'local') {
    const r = await fetch(`${WHISPER_URL}/inference`, {
      method: 'POST',
      body: wavForm(buf, { response_format: 'json', language: STT_LANGUAGE, temperature: '0' }),
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) throw new Error('whisper-server: ' + r.status);
    const j = await r.json();
    return clean(j.text);
  }
  const url = STT_PROVIDER === 'groq' ? 'https://api.groq.com/openai/v1/audio/transcriptions' : STT_URL;
  if (!url) throw new Error('STT_URL не задано');
  const r = await fetch(url, {
    method: 'POST',
    headers: STT_KEY ? { Authorization: 'Bearer ' + STT_KEY } : {},
    body: wavForm(buf, { model: STT_MODEL, language: STT_LANGUAGE, response_format: 'json', temperature: '0' }),
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error('STT ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  return clean(j.text);
}

async function sttReady() {
  try {
    if (STT_PROVIDER === 'local') { await fetch(WHISPER_URL + '/', { signal: AbortSignal.timeout(900) }); return true; }
    if (STT_PROVIDER === 'groq') return !!STT_KEY;
    return !!STT_URL;
  } catch { return false; }
}

const STT_LABEL = { local: 'whisper на цьому Mac', groq: 'Groq', custom: 'свій сервер' };
const STT_HINT = {
  local: 'Whisper не запущений. Закрий це вікно і відкрий start.command ще раз (він запускає whisper сам).',
  groq: 'Встав GROQ_API_KEY у файл .env і перезапусти start.command.',
  custom: 'Заповни STT_URL (і STT_KEY) у файлі .env.'
};

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, obj, req) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (req && req.headers.origin === 'null') { h['Access-Control-Allow-Origin'] = 'null'; }   // стартова сторінка index.html, відкрита як файл
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('Завеликий файл')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': req.headers.origin === 'null' ? 'null' : '', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }

  if (url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/ping') {
        const ok = await sttReady();
        return send(res, 200, { ok: true, stt: ok, provider: STT_LABEL[STT_PROVIDER] || STT_PROVIDER, hint: ok ? '' : (STT_HINT[STT_PROVIDER] || '') }, req);
      }
      if (url.pathname === '/api/transcribe' && req.method === 'POST') {
        const buf = await readBody(req);
        if (buf.length < 1000) return send(res, 200, { text: '' }, req);
        return send(res, 200, { text: await transcribe(buf) }, req);
      }
      return send(res, 404, { error: 'not found' }, req);
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) }, req);
    }
  }

  // статика
  let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ---------- запуск ----------
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const certFile = path.join(ROOT, 'certs', 'cert.pem'), keyFile = path.join(ROOT, 'certs', 'key.pem');
const useHttps = !env('NO_HTTPS') && fs.existsSync(certFile) && fs.existsSync(keyFile);

http.createServer(handler).listen(LOCAL_PORT, '127.0.0.1', () => console.log(`Комп'ютер:  http://localhost:${LOCAL_PORT}`));
if (useHttps) {
  https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler)
    .listen(PORT, '0.0.0.0', () => console.log(`Телефон:    https://${lan || 'IP-комп\'ютера'}:${PORT}   (та сама Wi-Fi мережа; браузер попередить про сертифікат, це нормально)`));
} else {
  http.createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`Телефон:    http://${lan || 'IP'}:${PORT}   (без https мікрофон на телефоні не запрацює; запускай через start.command)`));
}
console.log(`Розпізнавання: ${STT_LABEL[STT_PROVIDER] || STT_PROVIDER}, мова ${STT_LANGUAGE}`);
