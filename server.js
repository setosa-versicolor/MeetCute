'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Slots = require('./public/slots.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 256 * 1024;
// Default link-preview text in public/index.html, swapped for a MeetCute's own.
const DEFAULT_TITLE = 'MeetCute · Find a time that works for everyone';
const DEFAULT_DESC = 'Create a MeetCute, share the link with friends, and find the time that works for everyone.';
const LIMITS = { title: 80, description: 500, host: 40, name: 40, note: 140, dates: 60, slots: 2500, responses: 200 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; '),
};

// ---------- storage ----------

function createStore(file) {
  let data = { meetcutes: {} };
  if (file && fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      console.error('Could not read %s, starting fresh: %s', file, e.message);
    }
  }
  let timer = null;
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  return {
    get: (id) => (Object.prototype.hasOwnProperty.call(data.meetcutes, id) ? data.meetcutes[id] : undefined),
    put(mc) {
      data.meetcutes[mc.id] = mc;
      if (file && !timer) timer = setTimeout(flush, 100);
    },
    flush,
  };
}

// ---------- validation ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const bad = (msg) => new HttpError(400, msg);

function cleanText(v, max, label, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw bad(`${label} must be text`);
  // Strip control characters and collapse surrounding whitespace.
  v = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (required && !v) throw bad(`${label} is required`);
  if ([...v].length > max) throw bad(`${label} must be ${max} characters or fewer`);
  return v;
}

function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function validateMeetCute(body) {
  if (!body || typeof body !== 'object') throw bad('Missing body');
  const title = cleanText(body.title, LIMITS.title, 'Name', { required: true });
  const description = cleanText(body.description, LIMITS.description, 'Description');
  const host = cleanText(body.host, LIMITS.host, 'Your name');
  let emoji = cleanText(body.emoji, 16, 'Emoji') || 'users';

  const mode = body.mode === 'times' ? 'times' : body.mode === 'dates' ? 'dates' : null;
  if (!mode) throw bad('Mode must be "dates" or "times"');

  if (!Array.isArray(body.dates) || body.dates.length === 0) throw bad('Pick at least one date');
  const dates = [...new Set(body.dates)].sort();
  if (dates.length > LIMITS.dates) throw bad(`Pick ${LIMITS.dates} dates or fewer`);
  if (!dates.every(Slots.isValidDate)) throw bad('One of those dates looks off');

  let timezone = typeof body.timezone === 'string' && isValidTimeZone(body.timezone) ? body.timezone : 'UTC';

  const mc = { title, description, host, emoji, mode, dates, timezone };

  if (mode === 'times') {
    const slotMinutes = Number(body.slotMinutes);
    if (![15, 30, 60].includes(slotMinutes)) throw bad('Slot length must be 15, 30 or 60 minutes');
    const checkWindow = (startTime, endTime) => {
      const start = Slots.timeToMin(startTime);
      const end = Slots.timeToMin(endTime);
      if (isNaN(start) || isNaN(end)) throw bad('Times must look like HH:MM');
      if (start % slotMinutes !== 0 || end % slotMinutes !== 0) throw bad('Times must line up with the slot length');
      if (end - start < slotMinutes) throw bad('End time must be after start time');
    };
    checkWindow(body.startTime, body.endTime);
    Object.assign(mc, { startTime: body.startTime, endTime: body.endTime, slotMinutes });

    // Optional different hours for some days: { "2026-10-04": { startTime, endTime } }.
    if (body.dayTimes != null) {
      if (typeof body.dayTimes !== 'object' || Array.isArray(body.dayTimes)) throw bad('dayTimes must be an object');
      const dayTimes = {};
      for (const [date, w] of Object.entries(body.dayTimes)) {
        if (!dates.includes(date)) throw bad('Per-day times must be for one of the picked dates');
        if (!w || typeof w !== 'object') throw bad('Times must look like HH:MM');
        checkWindow(w.startTime, w.endTime);
        dayTimes[date] = { startTime: w.startTime, endTime: w.endTime };
      }
      if (Object.keys(dayTimes).length) mc.dayTimes = dayTimes;
    }
    if (Slots.slotIds(mc).length > LIMITS.slots) throw bad('That is a lot of slots! Try fewer dates or a shorter window.');
  }
  return mc;
}

function validateResponse(mc, body) {
  if (!body || typeof body !== 'object') throw bad('Missing body');
  const name = cleanText(body.name, LIMITS.name, 'Name', { required: true });
  const note = cleanText(body.note, LIMITS.note, 'Note');
  const valid = new Set(Slots.slotIds(mc));
  const pick = (arr, label) => {
    if (arr == null) return [];
    if (!Array.isArray(arr)) throw bad(`${label} must be a list`);
    const out = [...new Set(arr)];
    for (const s of out) if (!valid.has(s)) throw bad(`"${String(s).slice(0, 20)}" is not one of the options`);
    return out;
  };
  const yes = pick(body.yes, 'yes');
  const yesSet = new Set(yes);
  const maybe = pick(body.maybe, 'maybe').filter((s) => !yesSet.has(s));
  return { name, note, yes, maybe };
}

function publicView(mc) {
  const { adminKey, ...rest } = mc;
  return rest;
}

function checkAdmin(mc, key) {
  const a = Buffer.from(String(key || ''));
  const b = Buffer.from(mc.adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'Only the organizer can do that');
}

const newId = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// ---------- http helpers ----------

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- app ----------

function createApp({ dataFile } = {}) {
  const store = createStore(dataFile);
  const template = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  function renderIndex(res, mc) {
    // Fill in link-preview tags so shared links look nice in group chats.
    if (!mc) return send(res, 200, template, { 'Content-Type': MIME['.html'] });
    const title = `${mc.title} · MeetCute`;
    const desc = (mc.host ? `${mc.host} wants to know when you're free. ` : "When are you free? ") + 'Tap to pick your times.';
    const html = template.replaceAll(DEFAULT_TITLE, escapeHtml(title)).replaceAll(DEFAULT_DESC, escapeHtml(desc));
    send(res, 200, html, { 'Content-Type': MIME['.html'] });
  }

  function serveStatic(req, res, pathname) {
    const filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
  }

  async function handleApi(req, res, parts) {
    // parts: ['api', 'meetcutes', id?, sub?, subId?]
    const [, resource, id, sub, subId] = parts;
    if (resource !== 'meetcutes') throw new HttpError(404, 'Not found');

    if (!id) {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const fields = validateMeetCute(await readJson(req));
      let mcId;
      do { mcId = newId(6); } while (store.get(mcId));
      const mc = { id: mcId, adminKey: newId(18), ...fields, responses: [], locked: null, createdAt: new Date().toISOString() };
      store.put(mc);
      return send(res, 201, { meetcute: publicView(mc), adminKey: mc.adminKey });
    }

    const mc = store.get(id);
    if (!mc) throw new HttpError(404, "We couldn't find that MeetCute. Maybe it got lost in the group chat?");

    if (!sub) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { meetcute: publicView(mc) });
    }

    if (sub === 'responses' && !subId && req.method === 'PUT') {
      const r = validateResponse(mc, await readJson(req));
      const key = r.name.toLocaleLowerCase();
      const existing = mc.responses.find((x) => x.name.toLocaleLowerCase() === key);
      const now = new Date().toISOString();
      if (existing) {
        Object.assign(existing, r, { updatedAt: now });
      } else {
        if (mc.responses.length >= LIMITS.responses) throw bad('This MeetCute is full!');
        mc.responses.push({ id: newId(6), ...r, createdAt: now, updatedAt: now });
      }
      store.put(mc);
      return send(res, 200, { meetcute: publicView(mc) });
    }

    if (sub === 'responses' && subId && req.method === 'DELETE') {
      checkAdmin(mc, req.headers['x-admin-key']);
      const before = mc.responses.length;
      mc.responses = mc.responses.filter((r) => r.id !== subId);
      if (mc.responses.length === before) throw new HttpError(404, 'No such response');
      store.put(mc);
      return send(res, 200, { meetcute: publicView(mc) });
    }

    if (sub === 'lock' && req.method === 'POST') {
      checkAdmin(mc, req.headers['x-admin-key']);
      const body = await readJson(req);
      if (body.slots == null || (Array.isArray(body.slots) && body.slots.length === 0)) {
        mc.locked = null;
      } else {
        if (!Array.isArray(body.slots)) throw bad('slots must be a list');
        const valid = new Set(Slots.slotIds(mc));
        const slots = [...new Set(body.slots)].sort();
        if (!slots.every((s) => valid.has(s))) throw bad('That is not one of the options');
        if (new Set(slots.map(Slots.slotDate)).size !== 1) throw bad('Pick a time on a single day');
        mc.locked = { slots, at: new Date().toISOString() };
      }
      store.put(mc);
      return send(res, 200, { meetcute: publicView(mc) });
    }

    throw new HttpError(405, 'Method not allowed');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts[0] === 'api') return await handleApi(req, res, parts);

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      // Locally, always use this server's own storage rather than the Supabase setup in config.js.
      if (url.pathname === '/config.js') {
        return send(res, 200, 'window.MEETCUTE_CONFIG = {};\n', { 'Content-Type': MIME['.js'] });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const id = url.searchParams.get('m');
        return renderIndex(res, (id && store.get(id)) || null);
      }
      // Old-style links from before MeetCute moved to ?m= links.
      if (parts[0] === 'm' && parts.length === 2) {
        res.writeHead(302, { Location: '/?m=' + encodeURIComponent(parts[1]) });
        return res.end();
      }
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    }
  });

  server.on('close', () => store.flush());
  return { server, store };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'meetcutes.json');
  const { server, store } = createApp({ dataFile });
  server.listen(port, () => console.log(`MeetCute is live at http://localhost:${port}`));
  const shutdown = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, validateMeetCute, validateResponse };
