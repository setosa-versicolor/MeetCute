// Shared between the browser and the server: how a MeetCute's options are
// laid out, and how responses roll up into "matches".
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeetCuteSlots = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isValidDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }

  // "HH:MM" -> minutes since midnight. "24:00" is allowed as an end time.
  function timeToMin(t) {
    const m = /^(\d{2}):(\d{2})$/.exec(t || '');
    if (!m) return NaN;
    const h = +m[1], mi = +m[2];
    if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return NaN;
    return h * 60 + mi;
  }

  function minToTime(n) {
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }

  // The time window for one day: its own (mc.dayTimes) if the organizer set
  // different times per day, otherwise the MeetCute's usual hours.
  function dayWindow(mc, date) {
    const own = mc.dayTimes && mc.dayTimes[date];
    return own ? { startTime: own.startTime, endTime: own.endTime } : { startTime: mc.startTime, endTime: mc.endTime };
  }

  function rowsBetween(startTime, endTime, slotMinutes) {
    const start = timeToMin(startTime), end = timeToMin(endTime);
    const rows = [];
    for (let t = start; t + slotMinutes <= end; t += slotMinutes) rows.push(minToTime(t));
    return rows;
  }

  // Start times of the rows that exist on one day.
  function dayRows(mc, date) {
    if (mc.mode !== 'times') return [];
    const w = dayWindow(mc, date);
    return rowsBetween(w.startTime, w.endTime, mc.slotMinutes);
  }

  // Every row any day uses, in order (the rows of the time grid).
  function timeRows(mc) {
    if (mc.mode !== 'times') return [];
    if (!mc.dayTimes || !mc.dates) return rowsBetween(mc.startTime, mc.endTime, mc.slotMinutes);
    const all = new Set();
    for (const d of mc.dates) for (const t of dayRows(mc, d)) all.add(t);
    return [...all].sort();
  }

  // Every selectable option. Dates mode: "2026-10-04". Times mode: "2026-10-04T14:30".
  function slotIds(mc) {
    if (mc.mode !== 'times') return mc.dates.slice();
    const out = [];
    for (const d of mc.dates) for (const r of dayRows(mc, d)) out.push(d + 'T' + r);
    return out;
  }

  function slotDate(slot) { return slot.slice(0, 10); }
  function slotTime(slot) { return slot.length > 10 ? slot.slice(11) : null; }

  // Per-slot tallies: who is in, who is "if needed".
  function slotInfo(mc) {
    const responses = mc.responses || [];
    const sets = responses.map((r) => ({ name: r.name, yes: new Set(r.yes), maybe: new Set(r.maybe) }));
    const info = new Map();
    for (const slot of slotIds(mc)) {
      const yes = [], maybe = [], no = [];
      for (const r of sets) {
        if (r.yes.has(slot)) yes.push(r.name);
        else if (r.maybe.has(slot)) maybe.push(r.name);
        else no.push(r.name);
      }
      info.set(slot, { yes, maybe, no, score: yes.length + maybe.length * 0.5 });
    }
    return info;
  }

  // Groups back-to-back slots on the same day with the same crowd into one
  // window ("Sat 2pm–4:30pm"), then ranks windows best-first.
  function computeWindows(mc) {
    const info = slotInfo(mc);
    const groups = mc.mode === 'times'
      ? mc.dates.map((d) => dayRows(mc, d).map((t) => d + 'T' + t))
      : mc.dates.map((d) => [d]);
    const windows = [];
    for (const group of groups) {
      let cur = null;
      for (const slot of group) {
        const i = info.get(slot);
        if (!i || i.score === 0) { cur = null; continue; }
        const key = i.yes.join('\u0000') + '|' + i.maybe.join('\u0000');
        if (cur && cur.key === key) {
          cur.slots.push(slot);
        } else {
          cur = { key, slots: [slot], date: slotDate(slot), yes: i.yes, maybe: i.maybe, no: i.no, score: i.score };
          windows.push(cur);
        }
      }
    }
    for (const w of windows) {
      delete w.key;
      if (mc.mode === 'times') {
        w.start = slotTime(w.slots[0]);
        w.end = minToTime(timeToMin(slotTime(w.slots[w.slots.length - 1])) + mc.slotMinutes);
      }
    }
    windows.sort((a, b) =>
      b.score - a.score ||
      b.slots.length - a.slots.length ||
      (a.slots[0] < b.slots[0] ? -1 : 1));
    return windows;
  }

  // Offset (ms) of an IANA time zone at a given instant.
  function tzOffsetMs(utcMs, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - utcMs;
  }

  // Wall-clock date + time in `tz` -> real instant.
  function zonedToUtc(date, time, tz) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const wall = Date.UTC(y, m - 1, d, hh, mm);
    let t = wall - tzOffsetMs(wall, tz);
    t = wall - tzOffsetMs(t, tz);
    return new Date(t);
  }

  return { isValidDate, timeToMin, minToTime, dayWindow, dayRows, timeRows, slotIds, slotDate, slotTime, slotInfo, computeWindows, tzOffsetMs, zonedToUtc };
});
