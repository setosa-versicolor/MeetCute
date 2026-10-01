(() => {
  'use strict';

  const S = window.MeetCuteSlots;
  const app = document.getElementById('app');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const myTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // ---------- tiny helpers ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---------- backend ----------
  // With Supabase configured (config.js) the app talks to its database functions,
  // which is how the GitHub Pages site works. Otherwise it uses the local Node server.

  const CONFIG = window.MEETCUTE_CONFIG || {};

  function supabaseBackend({ supabaseUrl, supabaseKey }) {
    const headers = { apikey: supabaseKey, 'Content-Type': 'application/json' };
    // Legacy "anon" keys are JWTs and also go in Authorization; new publishable keys don't.
    if (supabaseKey.startsWith('eyJ')) headers.Authorization = `Bearer ${supabaseKey}`;
    async function rpc(fn, args) {
      let res;
      try {
        res = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
      } catch {
        throw new Error('Can’t reach the server. Check your connection? 📡');
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.message) || 'Something went wrong');
      return data;
    }
    return {
      create: (fields) => rpc('create_meetcute', { payload: fields }),
      get: (id) => rpc('get_meetcute', { p_id: id }),
      respond: (id, body) => rpc('upsert_response', { p_id: id, payload: body }),
      remove: (id, adminKey, rid) => rpc('delete_response', { p_id: id, p_admin_key: adminKey, p_response_id: rid }),
      lock: (id, adminKey, slots) => rpc('lock_meetcute', { p_id: id, p_admin_key: adminKey, p_slots: slots }),
    };
  }

  function localBackend() {
    async function api(method, url, body, headers = {}) {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!data.error && (res.status === 404 || res.status === 405)) throw new Error('MeetCute isn’t connected to a database yet. See the README to finish setup.');
        throw new Error(data.error || 'Something went wrong');
      }
      return data;
    }
    const base = (id) => 'api/meetcutes/' + encodeURIComponent(id);
    return {
      create: (fields) => api('POST', 'api/meetcutes', fields),
      get: (id) => api('GET', base(id)),
      respond: (id, body) => api('PUT', `${base(id)}/responses`, body),
      remove: (id, adminKey, rid) => api('DELETE', `${base(id)}/responses/${encodeURIComponent(rid)}`, null, { 'X-Admin-Key': adminKey }),
      lock: (id, adminKey, slots) => api('POST', `${base(id)}/lock`, { slots }, { 'X-Admin-Key': adminKey }),
    };
  }

  const backend = CONFIG.supabaseUrl && CONFIG.supabaseKey ? supabaseBackend(CONFIG) : localBackend();

  // Links look like ".../MeetCute/?m=abc123" so they work on static hosting.
  const homeUrl = () => location.origin + location.pathname;
  const meetcuteUrl = (id) => `${homeUrl()}?m=${encodeURIComponent(id)}`;

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    el.focus();
  }

  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { value: text, class: 'sr-only' });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg || 'Copied! 📋');
  }

  // ---------- dates & formatting ----------

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const todayYmd = () => ymd(new Date());

  const fmtDate = (s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
    parseYmd(s).toLocaleDateString(undefined, opts);

  function fmtTime(t) {
    const mins = S.timeToMin(t);
    const h24 = Math.floor(mins / 60) % 24, m = mins % 60;
    const h12 = h24 % 12 || 12;
    return `${h12}${m ? ':' + pad(m) : ''}${h24 < 12 ? 'am' : 'pm'}`;
  }

  function fmtSlot(mc, slot) {
    const date = fmtDate(S.slotDate(slot));
    if (mc.mode !== 'times') return date;
    const t = S.slotTime(slot);
    return `${date} · ${fmtTime(t)}–${fmtTime(S.minToTime(S.timeToMin(t) + mc.slotMinutes))}`;
  }

  function fmtWindow(mc, w) {
    const date = fmtDate(w.date, { weekday: 'long', month: 'short', day: 'numeric' });
    return mc.mode === 'times' ? `${date} · ${fmtTime(w.start)}–${fmtTime(w.end)}` : date;
  }

  function lockedWindow(mc) {
    if (!mc.locked) return null;
    const slots = mc.locked.slots;
    const w = { slots, date: S.slotDate(slots[0]) };
    if (mc.mode === 'times') {
      w.start = S.slotTime(slots[0]);
      w.end = S.minToTime(S.timeToMin(S.slotTime(slots[slots.length - 1])) + mc.slotMinutes);
    }
    return w;
  }

  // ---------- personality ----------

  const TAGLINES = [
    'Find the time that works for the whole crew.',
    'Because “when works for everyone?” shouldn’t take 47 texts.',
    'Herding friends, made easy.',
    'Less back-and-forth, more hanging out.',
    'Your group chat’s new favorite planner.',
  ];

  const NAME_IDEAS = [
    ['Taco Tuesday Summit', '🌮'], ['Operation: Brunch', '🥞'], ['The Great Game Night', '🎲'],
    ['Karaoke Confessions', '🎤'], ['Hike & Seek', '🥾'], ['Pizza Party Protocol', '🍕'],
    ['Book Club (We Read It, We Swear)', '📚'], ['Friendsgiving', '🦃'], ['Movie Marathon', '🎬'],
    ['Coffee & Chaos', '☕'], ['Trivia Night Dream Team', '🧠'], ['Sushi Rendezvous', '🍣'],
    ['Weekend Getaway Plotting', '🏕️'], ['Birthday Bash Planning', '🎂'], ['Happy Hour Huddle', '🍻'],
    ['Picnic in the Park', '🧺'], ['Escape Room Heist', '🔐'], ['Cookie Bake-Off', '🍪'],
  ];

  const EMOJIS = ['🙌', '🍕', '🍻', '☕', '🎲', '🎉', '🎬', '🥾', '🍣', '🎤', '🏕️', '🧁', '⚽', '🎮', '📚', '🌮'];

  const SAVE_LINES = [
    'Saved! The squad thanks you 🙏', 'You’re a legend 🏆', 'Got it! High five ✋',
    'Noted. Friendship level up ⬆️', 'Saved! You make planning easy 😎', 'Locked and loaded 🚀',
    'Teamwork makes the dream work 🤝',
  ];

  const EMPTY_LINES = [
    'No one has responded yet. Time to nudge the group chat 👀',
    'Crickets so far 🦗 Send that link around!',
    'Still waiting on the first response. Someone’s always fashionably late ⏰',
  ];

  const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐙', '🐝', '🦉', '🐧', '🐨', '🦁', '🐯', '🐻', '🐰', '🦋', '🐢', '🐳', '🦩', '🦦', '🐞', '🐲'];
  const AVATAR_HUES = [340, 12, 35, 150, 190, 220, 265, 300];

  function hash(str) {
    let x = 2166136261;
    for (const c of str.toLowerCase()) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }

  function avatar(name, size = '') {
    const n = hash(name);
    const el = h('span', { class: `avatar ${size}`, title: name, 'aria-hidden': 'true' }, AVATARS[n % AVATARS.length]);
    el.style.setProperty('--hue', AVATAR_HUES[(n >> 8) % AVATAR_HUES.length]);
    return el;
  }

  function chemistryLabel(pct) {
    if (pct >= 100) return 'The whole crew’s in! 🙌';
    if (pct >= 80) return 'Almost everyone 🔥';
    if (pct >= 60) return 'Looking good 😊';
    if (pct >= 40) return 'Getting there 🤔';
    return 'Herding cats 🐈';
  }

  // ---------- confetti ----------

  const confetti = (() => {
    const canvas = document.getElementById('confetti');
    const ctx = canvas.getContext('2d');
    let parts = [], running = false;

    function frame() {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      parts = parts.filter((p) => p.y < height + 40 && p.life > 0);
      for (const p of parts) {
        p.vy += 0.12; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 1;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life / 40);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.font = `${p.size}px serif`;
        ctx.fillText(p.char, -p.size / 2, p.size / 2);
        ctx.restore();
      }
      if (parts.length) requestAnimationFrame(frame);
      else { running = false; ctx.clearRect(0, 0, width, height); }
    }

    return function burst({ x, y, count = 40, chars = ['🎉', '✨', '🙌', '🥳', '🎊'] } = {}) {
      if (reducedMotion) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      x = (x ?? innerWidth / 2) * dpr;
      y = (y ?? innerHeight / 2) * dpr;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2, sp = (3 + Math.random() * 9) * dpr;
        parts.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6 * dpr,
          rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.2,
          size: (16 + Math.random() * 18) * dpr, char: pick(chars), life: 140 + Math.random() * 60,
        });
      }
      if (!running) { running = true; requestAnimationFrame(frame); }
    };
  })();

  function burstFrom(el, opts) {
    const r = el.getBoundingClientRect();
    confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2, ...opts });
  }

  // ---------- drag-to-paint ----------

  // Click or drag across cells. Works with mouse, touch and pen; Enter/Space for keyboard.
  function paintable(container, { onStart, onPaint, onEnd }) {
    let mode = null, last = null;
    const cellAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const cell = el && el.closest('[data-slot]');
      return cell && container.contains(cell) && !cell.classList.contains('disabled') ? cell : null;
    };
    const move = (e) => {
      const cell = cellAt(e.clientX, e.clientY);
      if (cell && cell !== last) { last = cell; onPaint(cell, mode); }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      mode = null; last = null;
      onEnd && onEnd();
    };
    container.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || mode != null) return;
      const cell = cellAt(e.clientX, e.clientY);
      if (!cell) return;
      e.preventDefault();
      if (e.target.hasPointerCapture && e.target.hasPointerCapture(e.pointerId)) e.target.releasePointerCapture(e.pointerId);
      mode = onStart(cell);
      last = cell;
      onPaint(cell, mode);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    container.addEventListener('keydown', (e) => {
      const cell = e.target.closest('[data-slot]');
      if (!cell || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      onPaint(cell, onStart(cell));
      onEnd && onEnd();
    });
  }

  // ---------- slot grid (shared by "your picks" and "results") ----------

  function slotGrid(mc, { cell, label }) {
    if (mc.mode !== 'times') {
      return h('div', { class: 'date-grid', role: 'group', 'aria-label': label },
        mc.dates.map((d) => {
          const dt = parseYmd(d);
          return cell(d, h('div', { class: 'date-card-inner' },
            h('span', { class: 'dow' }, dt.toLocaleDateString(undefined, { weekday: 'short' })),
            h('span', { class: 'dom' }, dt.getDate()),
            h('span', { class: 'mon' }, dt.toLocaleDateString(undefined, { month: 'short' }))));
        }));
    }
    const rows = S.timeRows(mc);
    const grid = h('div', { class: 'time-grid', role: 'group', 'aria-label': label });
    grid.style.setProperty('--cols', mc.dates.length);
    grid.append(h('div', { class: 'corner' }));
    for (const d of mc.dates) {
      const dt = parseYmd(d);
      grid.append(h('div', { class: 'col-head' },
        h('span', { class: 'dow' }, dt.toLocaleDateString(undefined, { weekday: 'short' })),
        h('span', { class: 'dom' }, dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))));
    }
    rows.forEach((t) => {
      const onHour = t.endsWith(':00') || mc.slotMinutes === 60;
      grid.append(h('div', { class: 'row-head' + (onHour ? ' hour' : '') }, onHour ? fmtTime(t) : ''));
      for (const d of mc.dates) {
        const c = cell(`${d}T${t}`, null);
        if (onHour) c.classList.add('hour');
        grid.append(c);
      }
    });
    return h('div', { class: 'time-grid-scroll' }, grid);
  }

  // =====================================================================
  // CREATE
  // =====================================================================

  function showCreate() {
    document.title = 'MeetCute 🙌 Get the crew together';
    const now = new Date();
    const draft = {
      title: '', description: '', host: store.get('mc-name') || '', emoji: '🙌',
      mode: 'dates', dates: new Set(),
      startTime: '09:00', endTime: '17:00', slotMinutes: 60,
      month: new Date(now.getFullYear(), now.getMonth(), 1),
    };

    // --- name + emoji ---
    const titleInput = h('input', {
      id: 'mc-title', class: 'input big', maxlength: 80, autocomplete: 'off',
      placeholder: 'e.g. Taco Tuesday Summit', oninput: (e) => { draft.title = e.target.value; },
    });
    const emojiBtns = EMOJIS.map((em) => h('button', {
      type: 'button', class: 'emoji-btn' + (em === draft.emoji ? ' on' : ''), 'aria-label': `Use ${em}`,
      onclick: () => setEmoji(em),
    }, em));
    function setEmoji(em) {
      draft.emoji = em;
      emojiBtns.forEach((b) => b.classList.toggle('on', b.textContent === em));
      emojiPreview.textContent = em;
    }
    const emojiPreview = h('span', { class: 'emoji-preview', 'aria-hidden': 'true' }, draft.emoji);
    const dice = h('button', {
      type: 'button', class: 'btn icon', title: 'Surprise me', 'aria-label': 'Suggest a fun name',
      onclick: () => {
        const [name, em] = pick(NAME_IDEAS.filter(([n]) => n !== draft.title));
        draft.title = titleInput.value = name;
        if (EMOJIS.includes(em)) setEmoji(em); else { draft.emoji = em; emojiPreview.textContent = em; emojiBtns.forEach((b) => b.classList.remove('on')); }
        dice.classList.remove('roll'); void dice.offsetWidth; dice.classList.add('roll');
      },
    }, '🎲');

    // --- calendar ---
    const calWrap = h('div', { class: 'calendar' });
    const dateSummary = h('p', { class: 'hint' });

    function renderCalendar() {
      const m = draft.month;
      const first = new Date(m.getFullYear(), m.getMonth(), 1);
      const startPad = first.getDay();
      const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      const today = todayYmd();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const days = h('div', { class: 'cal-days' });
      for (let i = 0; i < 7; i++) {
        days.append(h('div', { class: 'cal-dow' }, new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' })));
      }
      for (let i = 0; i < startPad; i++) days.append(h('div'));
      for (let d = 1; d <= daysInMonth; d++) {
        const s = ymd(new Date(m.getFullYear(), m.getMonth(), d));
        const past = s < today;
        days.append(h('div', {
          class: 'cal-day' + (draft.dates.has(s) ? ' on' : '') + (past ? ' disabled' : '') + (s === today ? ' today' : ''),
          dataset: { slot: s }, tabindex: past ? null : 0, role: 'button',
          'aria-pressed': String(draft.dates.has(s)), 'aria-label': fmtDate(s, { weekday: 'long', month: 'long', day: 'numeric' }),
        }, d));
      }
      paintable(days, {
        onStart: (cell) => !draft.dates.has(cell.dataset.slot),
        onPaint: (cell, on) => {
          if (on) draft.dates.add(cell.dataset.slot); else draft.dates.delete(cell.dataset.slot);
          cell.classList.toggle('on', on);
          cell.setAttribute('aria-pressed', String(on));
          if (on && !reducedMotion) { cell.classList.remove('pop'); void cell.offsetWidth; cell.classList.add('pop'); }
          updateSummary();
        },
      });

      calWrap.replaceChildren(
        h('div', { class: 'cal-head' },
          h('button', {
            type: 'button', class: 'btn icon', 'aria-label': 'Previous month', disabled: m <= thisMonth,
            onclick: () => { draft.month = new Date(m.getFullYear(), m.getMonth() - 1, 1); renderCalendar(); },
          }, '‹'),
          h('strong', { class: 'cal-title' }, m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
          h('button', {
            type: 'button', class: 'btn icon', 'aria-label': 'Next month',
            onclick: () => { draft.month = new Date(m.getFullYear(), m.getMonth() + 1, 1); renderCalendar(); },
          }, '›')),
        days);
    }

    function setDates(list) {
      draft.dates = new Set(list);
      if (list.length) { const f = parseYmd(list.slice().sort()[0]); draft.month = new Date(f.getFullYear(), f.getMonth(), 1); }
      renderCalendar();
      updateSummary();
    }

    const quick = h('div', { class: 'chips' },
      h('button', { type: 'button', class: 'chip', onclick: () => setDates([...Array(7)].map((_, i) => ymd(addDays(now, i)))) }, 'Next 7 days'),
      h('button', {
        type: 'button', class: 'chip', onclick: () => {
          const out = [];
          for (let i = 0; out.length < 8 && i < 40; i++) { const d = addDays(now, i); if (d.getDay() === 0 || d.getDay() === 6) out.push(ymd(d)); }
          setDates(out);
        },
      }, 'Next 4 weekends'),
      h('button', {
        type: 'button', class: 'chip', onclick: () => {
          const mon = addDays(now, ((8 - now.getDay()) % 7) || 7);
          setDates([0, 1, 2, 3, 4].map((i) => ymd(addDays(mon, i))));
        },
      }, 'Weekdays next week'),
      h('button', { type: 'button', class: 'chip ghost', onclick: () => setDates([]) }, 'Clear'));

    // --- mode + times ---
    const timeOptions = (sel, allow24) => {
      const out = [];
      for (let m = 0; m <= 24 * 60; m += 30) {
        if (m === 24 * 60 && !allow24) break;
        const t = S.minToTime(m);
        out.push(h('option', { value: t, selected: t === sel }, m === 24 * 60 ? 'midnight' : fmtTime(t)));
      }
      return out;
    };
    const startSel = h('select', { class: 'input', id: 'mc-start', onchange: (e) => { draft.startTime = e.target.value; updateSummary(); } }, timeOptions(draft.startTime, false));
    const endSel = h('select', { class: 'input', id: 'mc-end', onchange: (e) => { draft.endTime = e.target.value; updateSummary(); } }, timeOptions(draft.endTime, true));
    const slotSel = h('select', { class: 'input', id: 'mc-slot', onchange: (e) => { draft.slotMinutes = +e.target.value; updateSummary(); } },
      [15, 30, 60].map((n) => h('option', { value: n, selected: n === draft.slotMinutes }, n === 60 ? '1 hour' : `${n} min`)));

    const setRange = (a, b) => { draft.startTime = startSel.value = a; draft.endTime = endSel.value = b; updateSummary(); };
    const timePanel = h('div', { class: 'time-panel', hidden: true },
      h('div', { class: 'chips' },
        h('button', { type: 'button', class: 'chip', onclick: () => setRange('08:00', '12:00') }, '🌅 Morning'),
        h('button', { type: 'button', class: 'chip', onclick: () => setRange('12:00', '17:00') }, '☀️ Afternoon'),
        h('button', { type: 'button', class: 'chip', onclick: () => setRange('17:00', '22:00') }, '🌙 Evening'),
        h('button', { type: 'button', class: 'chip', onclick: () => setRange('08:00', '22:00') }, '🌈 All day')),
      h('div', { class: 'time-row' },
        h('label', null, 'From', startSel),
        h('label', null, 'To', endSel),
        h('label', null, 'Slots of', slotSel)),
      h('p', { class: 'hint' }, `Times are in your time zone (${myTimeZone}).`));

    const modeBtns = [['dates', '📅', 'Dates only', 'Just figure out which day'], ['times', '⏰', 'Dates & times', 'Pin down the hour too']]
      .map(([val, icon, label, sub]) => h('button', {
        type: 'button', class: 'mode-btn' + (draft.mode === val ? ' on' : ''), role: 'radio',
        'aria-checked': String(draft.mode === val), dataset: { mode: val },
        onclick: () => {
          draft.mode = val;
          modeBtns.forEach((b) => { const on = b.dataset.mode === val; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
          timePanel.hidden = val !== 'times';
          updateSummary();
        },
      }, h('span', { class: 'mode-icon' }, icon), h('strong', null, label), h('small', null, sub)));

    function slotCount() {
      if (draft.mode !== 'times') return draft.dates.size;
      return draft.dates.size * S.timeRows({ mode: 'times', startTime: draft.startTime, endTime: draft.endTime, slotMinutes: draft.slotMinutes }).length;
    }

    function updateSummary() {
      const n = draft.dates.size;
      if (!n) { dateSummary.textContent = 'Tap or drag across days to pick them.'; return; }
      let txt = `${n} ${n === 1 ? 'date' : 'dates'} picked`;
      if (draft.mode === 'times') {
        const rows = S.timeRows({ mode: 'times', startTime: draft.startTime, endTime: draft.endTime, slotMinutes: draft.slotMinutes }).length;
        txt += rows ? ` × ${rows} time slots = ${slotCount()} options` : ' · (pick an end time after the start time)';
      }
      dateSummary.textContent = txt + (n > 1 ? ' 👌' : '');
    }

    const descInput = h('textarea', {
      class: 'input', rows: 2, maxlength: 500, placeholder: 'Where? What to bring? Any details (optional)',
      oninput: (e) => { draft.description = e.target.value; },
    });
    const hostInput = h('input', {
      class: 'input', maxlength: 40, placeholder: 'So people know who’s asking', value: draft.host, autocomplete: 'name',
      oninput: (e) => { draft.host = e.target.value; },
    });

    const submit = h('button', { type: 'submit', class: 'btn primary big' }, 'Create my MeetCute ✨');
    const errorEl = h('p', { class: 'error', role: 'alert' });

    const form = h('form', {
      class: 'create-form', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        if (!draft.title.trim()) { errorEl.textContent = 'Every great story needs a name 📖'; return shake(titleInput); }
        if (!draft.dates.size) { errorEl.textContent = 'Pick at least one date 📅'; calWrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
        if (draft.mode === 'times' && S.timeToMin(draft.endTime) <= S.timeToMin(draft.startTime)) { errorEl.textContent = 'End time needs to be after the start time ⏰'; return shake(endSel); }
        submit.disabled = true;
        submit.textContent = 'Rallying the troops… 📣';
        try {
          if (draft.host.trim()) store.set('mc-name', draft.host.trim());
          const { meetcute, adminKey } = await backend.create({
            title: draft.title, description: draft.description, host: draft.host, emoji: draft.emoji,
            mode: draft.mode, dates: [...draft.dates].sort(),
            startTime: draft.startTime, endTime: draft.endTime, slotMinutes: draft.slotMinutes,
            timezone: myTimeZone,
          });
          store.set('mc-admin-' + meetcute.id, adminKey);
          store.set('mc-fresh-' + meetcute.id, '1');
          confetti({ count: 70 });
          navigate('?m=' + encodeURIComponent(meetcute.id));
        } catch (err) {
          errorEl.textContent = err.message;
          submit.disabled = false;
          submit.textContent = 'Create my MeetCute ✨';
        }
      },
    },
    h('section', { class: 'card step' },
      h('h2', null, h('span', { class: 'step-num' }, '1'), 'Name it'),
      h('div', { class: 'title-row' }, emojiPreview, titleInput, dice),
      h('div', { class: 'emoji-row', role: 'group', 'aria-label': 'Pick an emoji' }, emojiBtns),
      h('label', { class: 'field' }, h('span', null, 'Your name'), hostInput),
      h('label', { class: 'field' }, h('span', null, 'Details'), descInput)),
    h('section', { class: 'card step' },
      h('h2', null, h('span', { class: 'step-num' }, '2'), 'Pick the dates'),
      quick, calWrap, dateSummary),
    h('section', { class: 'card step' },
      h('h2', null, h('span', { class: 'step-num' }, '3'), 'Want times too?'),
      h('div', { class: 'mode-row', role: 'radiogroup', 'aria-label': 'Dates only or dates and times' }, modeBtns),
      timePanel),
    h('div', { class: 'submit-row' }, errorEl, submit));

    renderCalendar();
    updateSummary();

    app.replaceChildren(
      h('section', { class: 'hero' },
        h('h1', null, 'Let’s get the crew together ', h('span', { class: 'wiggle' }, '🙌')),
        h('p', { class: 'tagline' }, pick(TAGLINES)),
        h('ol', { class: 'how' },
          h('li', null, h('span', null, '✍️'), 'Pick some options'),
          h('li', null, h('span', null, '📲'), 'Share with friends'),
          h('li', null, h('span', null, '🙌'), 'Find the best time'))),
      form);
    titleInput.focus({ preventScroll: true });
  }

  // =====================================================================
  // VIEW / RESPOND / RESULTS
  // =====================================================================

  let pollTimer = null;

  async function showMeetCute(id) {
    const params = new URLSearchParams(location.search);
    if (params.get('admin')) {
      store.set('mc-admin-' + id, params.get('admin'));
      history.replaceState(null, '', '?m=' + encodeURIComponent(id));
    }
    app.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'beat' }, '🎈'), 'Gathering the gang…'));

    let mc;
    try {
      ({ meetcute: mc } = await backend.get(id));
    } catch (err) {
      app.replaceChildren(h('section', { class: 'card empty-state' },
        h('div', { class: 'big-emoji' }, '🤷'), h('h1', null, 'Hmm, no MeetCute here'), h('p', null, err.message),
        h('a', { class: 'btn primary', href: './', 'data-link': true }, 'Start a new one')));
      return;
    }

    const adminKey = store.get('mc-admin-' + id);
    const isAdmin = !!adminKey;
    const fresh = store.get('mc-fresh-' + id) === '1';
    if (fresh) { try { localStorage.removeItem('mc-fresh-' + id); } catch { /* ignore */ } }
    const shareUrl = meetcuteUrl(id);
    document.title = `${mc.emoji} ${mc.title} · MeetCute`;

    // --- "mine" state ---
    const mine = { yes: new Set(), maybe: new Set(), note: '' };
    let brush = 'yes';
    let dirty = false;
    let loadedName = null;

    // --- header ---
    const header = h('section', { class: 'mc-header' });
    const lockBanner = h('div');
    const sharePanel = h('div');

    function renderHeader() {
      const tzNote = mc.mode === 'times'
        ? h('p', { class: 'tz-note' + (mc.timezone !== myTimeZone ? ' warn' : '') },
          `🕐 Times are in ${mc.timezone.replace(/_/g, ' ')}`,
          mc.timezone !== myTimeZone ? ` (you’re in ${myTimeZone.replace(/_/g, ' ')}, heads up!)` : '')
        : null;
      header.replaceChildren(
        h('div', { class: 'mc-emoji', 'aria-hidden': 'true' }, mc.emoji),
        h('div', { class: 'mc-title-wrap' },
          h('h1', null, mc.title),
          mc.host ? h('p', { class: 'host' }, avatar(mc.host, 'sm'), `Hosted by ${mc.host}`) : null,
          mc.description ? h('p', { class: 'desc' }, mc.description) : null,
          tzNote),
        h('div', { class: 'mc-actions' },
          h('button', { class: 'btn small', type: 'button', onclick: () => shareMe() }, '📣 Invite friends')));
    }

    async function shareMe() {
      const text = inviteText();
      if (navigator.share) {
        try { await navigator.share({ title: mc.title, text, url: shareUrl }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      renderShare(true);
      sharePanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function inviteText() {
      return `${mc.emoji} You’re invited: ${mc.title}! ${mc.host ? mc.host + ' wants' : 'We want'} to know when you’re free. Pick your times here 👇`;
    }

    function renderShare(open) {
      if (!open) { sharePanel.replaceChildren(); return; }
      const adminUrl = `${shareUrl}&admin=${encodeURIComponent(adminKey)}`;
      const linkInput = h('input', { class: 'input mono', readonly: true, value: shareUrl, onfocus: (e) => e.target.select(), 'aria-label': 'Share link' });
      sharePanel.replaceChildren(h('section', { class: 'card share-card' + (fresh ? ' fresh' : '') },
        h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: () => renderShare(false) }, '×'),
        h('h2', null, fresh ? 'Your MeetCute is ready! 🎉' : 'Rally the crew 📣'),
        h('p', null, 'Send this link to the group. Anyone with it can add their availability.'),
        h('div', { class: 'copy-row' }, linkInput,
          h('button', { class: 'btn primary', type: 'button', onclick: (e) => { copy(shareUrl, 'Link copied! Go round up the gang 📣'); burstFrom(e.currentTarget, { count: 14 }); } }, 'Copy link')),
        h('div', { class: 'chips' },
          navigator.share ? h('button', { class: 'chip', type: 'button', onclick: shareMe }, '📤 Share…') : null,
          h('button', { class: 'chip', type: 'button', onclick: () => copy(`${inviteText()}\n${shareUrl}`, 'Invite copied! Paste it in the group chat 💬') }, '💬 Copy invite message'),
          h('a', { class: 'chip', href: `sms:?&body=${encodeURIComponent(inviteText() + ' ' + shareUrl)}` }, '📱 Text it'),
          h('a', { class: 'chip', href: `mailto:?subject=${encodeURIComponent(mc.emoji + ' ' + mc.title)}&body=${encodeURIComponent(inviteText() + '\n\n' + shareUrl)}` }, '✉️ Email it')),
        isAdmin ? h('details', { class: 'admin-link' },
          h('summary', null, '🤫 Your secret organizer link'),
          h('p', { class: 'hint' }, 'Bookmark this one and keep it to yourself. It lets you lock in the final time and tidy up responses from any device.'),
          h('div', { class: 'copy-row' },
            h('input', { class: 'input mono', readonly: true, value: adminUrl, onfocus: (e) => e.target.select(), 'aria-label': 'Organizer link' }),
            h('button', { class: 'btn', type: 'button', onclick: () => copy(adminUrl, 'Organizer link copied. Keep it secret, keep it safe 🤫') }, 'Copy'))) : null));
    }

    // --- locked banner ---
    function renderLock() {
      const w = lockedWindow(mc);
      if (!w) { lockBanner.replaceChildren(); return; }
      lockBanner.replaceChildren(h('section', { class: 'card locked-banner' },
        h('div', { class: 'ring', 'aria-hidden': 'true' }, '📌'),
        h('div', null,
          h('p', { class: 'eyebrow' }, 'It’s a plan!'),
          h('h2', null, fmtWindow(mc, w)),
          h('div', { class: 'chips' },
            h('a', { class: 'chip', href: googleCalUrl(mc, w), target: '_blank', rel: 'noopener' }, '📆 Add to Google Calendar'),
            h('button', { class: 'chip', type: 'button', onclick: () => downloadIcs(mc, w) }, '🗓️ Download .ics'),
            isAdmin ? h('button', { class: 'chip ghost', type: 'button', onclick: () => lockIn(null) }, 'Unlock') : null))));
    }

    async function lockIn(slots, fromEl) {
      try {
        ({ meetcute: mc } = await backend.lock(id, adminKey, slots));
        renderLock();
        renderResults();
        if (slots) {
          confetti({ count: 90, chars: ['🎉', '🥳', '🎊', '✨', '📌'] });
          toast('It’s official! 📌 Now tell the group.');
          lockBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else toast('Unlocked. Back to the drawing board ✏️');
      } catch (err) { toast(err.message); }
    }

    // --- my availability ---
    const nameInput = h('input', {
      class: 'input big', id: 'my-name', maxlength: 40, autocomplete: 'name', placeholder: 'Type your name',
      value: store.get('mc-name') || '',
      onchange: () => loadMine(true), onblur: () => loadMine(true),
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); loadMine(true); } },
    });
    const greet = h('p', { class: 'greet', 'aria-live': 'polite' });
    const noteInput = h('input', {
      class: 'input', maxlength: 140, placeholder: 'Leave a note for the group (optional) ✏️',
      oninput: (e) => { mine.note = e.target.value; dirty = true; },
    });
    const myGridHost = h('div', { class: 'grid-host' });
    const myCount = h('span', { class: 'count-pill' });
    const saveBtn = h('button', { class: 'btn primary big', type: 'button', onclick: () => save() }, 'Save my availability 🙌');

    function findResponse(name) {
      const key = name.trim().toLocaleLowerCase();
      return key ? mc.responses.find((r) => r.name.toLocaleLowerCase() === key) : null;
    }

    function loadMine(announce) {
      const name = nameInput.value.trim();
      if (!name) { greet.textContent = ''; return; }
      if (name === loadedName) return;
      const r = findResponse(name);
      if (r && (!dirty || confirm(`Load ${r.name}’s saved picks? Your unsaved changes will be replaced.`))) {
        mine.yes = new Set(r.yes); mine.maybe = new Set(r.maybe); mine.note = noteInput.value = r.note || '';
        dirty = false;
        renderMyGrid();
        greet.replaceChildren(avatar(r.name, 'sm'), ` Welcome back, ${r.name}! Here’s what you picked last time.`);
      } else if (announce) {
        greet.replaceChildren(avatar(name, 'sm'), ` ${pick(['Hi', 'Hey', 'Hello', 'Ooh, hi'])} ${name}! ${pick(['Nice to meet you 👋', 'Tap the times that work 👇', 'Paint your free times below 🎨'])}`);
      }
      loadedName = name;
    }

    function cellState(slot) { return mine.yes.has(slot) ? 'yes' : mine.maybe.has(slot) ? 'maybe' : 'no'; }

    function applyCell(cell) {
      const st = cellState(cell.dataset.slot);
      cell.classList.toggle('yes', st === 'yes');
      cell.classList.toggle('maybe', st === 'maybe');
      cell.setAttribute('aria-label', `${fmtSlot(mc, cell.dataset.slot)}: ${st === 'yes' ? 'available' : st === 'maybe' ? 'if needed' : 'not available'}`);
    }

    function updateCount() {
      const total = S.slotIds(mc).length;
      myCount.textContent = `${mine.yes.size} yes · ${mine.maybe.size} maybe · ${total - mine.yes.size - mine.maybe.size} no`;
    }

    function renderMyGrid() {
      const grid = slotGrid(mc, {
        label: 'Your availability',
        cell: (slot, inner) => {
          const c = h('div', { class: 'cell mine', dataset: { slot }, tabindex: 0, role: 'button' }, inner);
          applyCell(c);
          return c;
        },
      });
      paintable(grid, {
        onStart: (cell) => (cellState(cell.dataset.slot) === brush ? 'no' : brush),
        onPaint: (cell, mode) => {
          const s = cell.dataset.slot;
          mine.yes.delete(s); mine.maybe.delete(s);
          if (mode === 'yes') mine.yes.add(s);
          if (mode === 'maybe') mine.maybe.add(s);
          dirty = true;
          applyCell(cell);
          updateCount();
        },
      });
      myGridHost.replaceChildren(grid);
      updateCount();
    }

    const brushBtns = [['yes', '✅', 'I’m free'], ['maybe', '🤞', 'If needed'], ['no', '🧽', 'Erase']].map(([val, icon, label]) =>
      h('button', {
        type: 'button', class: `brush brush-${val}` + (brush === val ? ' on' : ''), role: 'radio', 'aria-checked': String(brush === val),
        dataset: { brush: val },
        onclick: () => {
          brush = val;
          brushBtns.forEach((b) => { const on = b.dataset.brush === val; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
        },
      }, h('span', { 'aria-hidden': 'true' }, icon), label));

    const fillAll = (kind) => {
      mine.yes.clear(); mine.maybe.clear();
      if (kind) for (const s of S.slotIds(mc)) mine[kind].add(s);
      dirty = true;
      renderMyGrid();
    };

    async function save() {
      const name = nameInput.value.trim();
      if (!name) { greet.textContent = 'First things first: what’s your name? 😊'; return shake(nameInput); }
      const existing = findResponse(name);
      if (existing && loadedName !== name && !confirm(`Someone named ${existing.name} already responded. Replace their answers with yours?`)) return;
      const before = bestPct();
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving… 💭';
      try {
        ({ meetcute: mc } = await backend.respond(id, {
          name, yes: [...mine.yes], maybe: [...mine.maybe], note: mine.note,
        }));
        store.set('mc-name', name);
        loadedName = name;
        dirty = false;
        renderResults();
        const best = computeBest();
        if (best && best.perfect && before < 100) {
          confetti({ count: 120 });
          toast(`Everyone’s free ${fmtWindow(mc, best.w)}! It’s happening 🎉`);
        } else {
          burstFrom(saveBtn);
          toast(pick(SAVE_LINES));
        }
        if (!mine.yes.size && !mine.maybe.size) toast('Saved… but you’re free never? 🥲 We’ll miss you.');
      } catch (err) {
        toast(err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Update my availability 🙌';
      }
    }

    // --- results ---
    const resultsHost = h('div');
    let focusPerson = null;
    let detailSlot = null;

    function computeBest() {
      const n = mc.responses.length;
      const windows = S.computeWindows(mc);
      if (!n || !windows.length) return null;
      const w = windows[0];
      return { w, pct: Math.round((w.score / n) * 100), perfect: n >= 2 && w.yes.length === n };
    }
    function bestPct() { const b = computeBest(); return b ? b.pct : 0; }

    function renderResults() {
      const n = mc.responses.length;
      const info = S.slotInfo(mc);
      const windows = S.computeWindows(mc);

      if (!n) {
        resultsHost.replaceChildren(h('section', { class: 'card results' },
          h('h2', null, 'Group results'),
          h('div', { class: 'empty-state' }, h('div', { class: 'big-emoji float' }, '📬'), h('p', null, pick(EMPTY_LINES)))));
        return;
      }

      // Detail panel for whichever slot is hovered / tapped.
      const detail = h('div', { class: 'slot-detail', 'aria-live': 'polite' });
      function showDetail(slot) {
        detailSlot = slot;
        if (!slot) { detail.replaceChildren(h('p', { class: 'hint' }, 'Hover or tap a slot to see who’s in 👀')); return; }
        const i = info.get(slot);
        const people = (names, cls, label) => names.length
          ? h('div', { class: 'who ' + cls }, h('strong', null, `${label} (${names.length})`), h('div', { class: 'who-list' }, names.map((nm) => h('span', { class: 'person' }, avatar(nm, 'xs'), nm))))
          : null;
        detail.replaceChildren(
          h('p', { class: 'detail-title' }, fmtSlot(mc, slot)),
          people(i.yes, 'yes', '✅ Free'),
          people(i.maybe, 'maybe', '🤞 If needed'),
          people(i.no, 'no', '❌ Can’t make it'));
      }

      const grid = slotGrid(mc, {
        label: 'Group availability heatmap',
        cell: (slot, inner) => {
          const i = info.get(slot);
          const heat = n ? i.score / n : 0;
          const perfect = n >= 2 && i.yes.length === n;
          const c = h('div', {
            class: 'cell heat' + (perfect ? ' perfect' : '') + (mc.locked && mc.locked.slots.includes(slot) ? ' locked' : ''),
            dataset: { slot }, tabindex: 0,
            'aria-label': `${fmtSlot(mc, slot)}: ${i.yes.length} free, ${i.maybe.length} if needed`,
          }, inner, mc.mode === 'times' ? h('span', { class: 'cell-count' }, i.yes.length ? i.yes.length : '') : h('span', { class: 'cell-count' }, `${i.yes.length}/${n}`));
          c.style.setProperty('--heat', heat.toFixed(3));
          if (focusPerson) {
            const r = mc.responses.find((x) => x.name === focusPerson);
            c.classList.toggle('dim', !(r && (r.yes.includes(slot) || r.maybe.includes(slot))));
          }
          return c;
        },
      });
      grid.addEventListener('pointerover', (e) => { const c = e.target.closest('[data-slot]'); if (c && c.dataset.slot !== detailSlot) showDetail(c.dataset.slot); });
      grid.addEventListener('focusin', (e) => { const c = e.target.closest('[data-slot]'); if (c) showDetail(c.dataset.slot); });
      grid.addEventListener('click', (e) => { const c = e.target.closest('[data-slot]'); if (c) showDetail(c.dataset.slot); });
      showDetail(detailSlot && info.has(detailSlot) ? detailSlot : null);

      // Chemistry meter.
      const best = computeBest();
      const meter = best ? h('div', { class: 'meter' },
        h('div', { class: 'meter-label' }, h('span', null, 'Squad sync'), h('strong', null, `${best.pct}% · ${chemistryLabel(best.pct)}`)),
        h('div', { class: 'meter-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': best.pct },
          (() => { const f = h('div', { class: 'meter-fill' }); f.style.setProperty('--pct', best.pct + '%'); return f; })())) : null;

      // Best times.
      const medals = ['🥇', '🥈', '🥉'];
      const matches = windows.slice(0, 3).map((w, idx) => {
        const perfect = n >= 2 && w.yes.length === n;
        return h('li', { class: 'match' + (perfect ? ' perfect' : '') },
          h('span', { class: 'medal', 'aria-hidden': 'true' }, perfect ? '🙌' : medals[idx]),
          h('div', { class: 'match-body' },
            h('strong', null, fmtWindow(mc, w)),
            h('span', { class: 'match-sub' },
              perfect ? 'Everyone’s free! 🎉' : `${w.yes.length} of ${n} free` + (w.maybe.length ? ` · ${w.maybe.length} if needed` : '') + (w.no.length ? ` · missing ${w.no.join(', ')}` : '')),
            h('span', { class: 'avatars' }, w.yes.map((nm) => avatar(nm, 'xs')))),
          isAdmin ? h('button', { class: 'btn small', type: 'button', onclick: (e) => lockIn(w.slots, e.currentTarget) }, 'Lock it in 📌') : null);
      });

      // People.
      const people = mc.responses.slice().sort((a, b) => a.createdAt < b.createdAt ? -1 : 1).map((r) =>
        h('li', {
          class: 'person-chip' + (focusPerson === r.name ? ' on' : ''),
          onpointerenter: (e) => { if (e.pointerType === 'mouse') { focusPerson = r.name; dimFor(r.name); } },
          onpointerleave: (e) => { if (e.pointerType === 'mouse') { focusPerson = null; dimFor(null); } },
        },
        h('button', {
          type: 'button', class: 'person-btn', 'aria-pressed': String(focusPerson === r.name),
          onclick: () => { focusPerson = focusPerson === r.name ? null : r.name; renderResults(); },
        }, avatar(r.name), h('span', { class: 'person-name' }, r.name),
        h('span', { class: 'person-meta' }, `${r.yes.length}${r.maybe.length ? ` + ${r.maybe.length}?` : ''}`)),
        r.note ? h('span', { class: 'person-note' }, `“${r.note}”`) : null,
        isAdmin ? h('button', {
          type: 'button', class: 'remove', 'aria-label': `Remove ${r.name}`, title: 'Remove response',
          onclick: async () => {
            if (!confirm(`Remove ${r.name}’s response?`)) return;
            try {
              ({ meetcute: mc } = await backend.remove(id, adminKey, r.id));
              if (focusPerson === r.name) focusPerson = null;
              renderResults();
              toast(`${r.name} has left the chat 👋`);
            } catch (err) { toast(err.message); }
          },
        }, '×') : null));

      function dimFor(name) {
        const r = name && mc.responses.find((x) => x.name === name);
        grid.querySelectorAll('[data-slot]').forEach((c) => {
          c.classList.toggle('dim', !!r && !(r.yes.includes(c.dataset.slot) || r.maybe.includes(c.dataset.slot)));
        });
      }

      resultsHost.replaceChildren(h('section', { class: 'card results' },
        h('div', { class: 'results-head' },
          h('h2', null, 'Group results'),
          h('span', { class: 'count-pill' }, `${n} ${n === 1 ? 'person' : 'people'} responded`)),
        meter,
        matches.length ? h('div', null, h('h3', null, 'Best times'), h('ol', { class: 'matches' }, matches)) : h('p', { class: 'hint' }, 'No overlap yet. Keep the faith 🤞'),
        h('h3', null, 'Who’s in'),
        h('ul', { class: 'people' }, people),
        h('div', { class: 'heat-legend' },
          h('span', null, 'Fewer'), h('span', { class: 'legend-bar' }), h('span', null, 'More'),
          n >= 2 ? h('span', { class: 'legend-perfect' }, '🙌 everyone') : null),
        grid,
        detail));
    }

    // --- layout ---
    renderHeader();
    renderLock();
    renderShare(fresh && isAdmin);
    renderMyGrid();
    renderResults();

    app.replaceChildren(
      header, sharePanel, lockBanner,
      h('div', { class: 'two-col' },
        h('section', { class: 'card respond' },
          h('h2', null, 'Your availability'),
          h('label', { class: 'field' }, h('span', null, 'Who’s this?'), nameInput),
          greet,
          h('div', { class: 'brush-row' },
            h('div', { class: 'brushes', role: 'radiogroup', 'aria-label': 'Paint brush' }, brushBtns),
            h('div', { class: 'chips' },
              h('button', { type: 'button', class: 'chip', onclick: () => fillAll('yes') }, 'I’m free for all of it'),
              h('button', { type: 'button', class: 'chip ghost', onclick: () => fillAll(null) }, 'Clear'))),
          h('p', { class: 'hint' }, mc.mode === 'times' ? 'Click or drag across the grid to paint your times.' : 'Tap or drag across the days that work for you.'),
          myGridHost,
          h('div', { class: 'save-row' }, noteInput, myCount, saveBtn)),
        resultsHost));

    if (nameInput.value) loadMine(false);
    if (findResponse(nameInput.value)) saveBtn.textContent = 'Update my availability 🙌';

    window.onbeforeunload = () => (dirty ? true : undefined);

    // Live-ish updates: refresh results while the tab is visible.
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (document.hidden || currentId() !== id) return;
      try {
        const { meetcute: fresh2 } = await backend.get(id);
        const changed = JSON.stringify(fresh2.responses) !== JSON.stringify(mc.responses) || JSON.stringify(fresh2.locked) !== JSON.stringify(mc.locked);
        if (!changed) return;
        const newNames = fresh2.responses.filter((r) => !mc.responses.some((x) => x.id === r.id)).map((r) => r.name);
        const lockChanged = JSON.stringify(fresh2.locked) !== JSON.stringify(mc.locked);
        mc = fresh2;
        renderResults();
        if (lockChanged) { renderLock(); if (mc.locked) confetti({ count: 60, chars: ['🎉', '🥳', '📌'] }); }
        if (newNames.length) toast(`${newNames.join(', ')} just joined the party 🎉`);
      } catch { /* offline; try again later */ }
    }, 15000);
  }

  // ---------- calendar export ----------

  function eventTimes(mc, w) {
    if (mc.mode !== 'times') {
      const start = w.date.replace(/-/g, '');
      const end = ymd(addDays(parseYmd(w.date), 1)).replace(/-/g, '');
      return { allDay: true, start, end };
    }
    const iso = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const startD = S.zonedToUtc(w.date, w.start, mc.timezone);
    const endD = new Date(startD.getTime() + (S.timeToMin(w.end) - S.timeToMin(w.start)) * 60000);
    return { allDay: false, start: iso(startD), end: iso(endD) };
  }

  function googleCalUrl(mc, w) {
    const t = eventTimes(mc, w);
    const p = new URLSearchParams({
      action: 'TEMPLATE', text: `${mc.emoji} ${mc.title}`, dates: `${t.start}/${t.end}`,
      details: `${mc.description ? mc.description + '\n\n' : ''}Planned with MeetCute 🙌 ${meetcuteUrl(mc.id)}`,
    });
    return 'https://calendar.google.com/calendar/render?' + p;
  }

  function downloadIcs(mc, w) {
    const t = eventTimes(mc, w);
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MeetCute//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:${mc.id}-${t.start}@meetcute`, `DTSTAMP:${stamp}`,
      t.allDay ? `DTSTART;VALUE=DATE:${t.start}` : `DTSTART:${t.start}`,
      t.allDay ? `DTEND;VALUE=DATE:${t.end}` : `DTEND:${t.end}`,
      `SUMMARY:${esc(mc.emoji + ' ' + mc.title)}`,
      `DESCRIPTION:${esc((mc.description ? mc.description + '\n\n' : '') + 'Planned with MeetCute 🙌')}`,
      `URL:${meetcuteUrl(mc.id)}`,
      'END:VEVENT', 'END:VCALENDAR',
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${mc.title.replace(/[^\w-]+/g, '-').slice(0, 40) || 'meetcute'}.ics` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- routing ----------

  function currentId() {
    const id = new URLSearchParams(location.search).get('m');
    return id && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : null;
  }

  function navigate(path) {
    history.pushState(null, '', path);
    route();
  }

  function route() {
    clearInterval(pollTimer);
    window.onbeforeunload = null;
    window.scrollTo(0, 0);
    const id = currentId();
    if (id) showMeetCute(id); else showCreate();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (window.onbeforeunload && window.onbeforeunload() && !confirm('You have unsaved picks. Leave anyway?')) return;
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', route);

  route();
})();
