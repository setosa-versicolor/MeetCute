'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');

let base, server;
test.before(async () => {
  ({ server } = createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
};

const newMc = (extra = {}) => call('POST', '/api/meetcutes', {
  title: 'Game Night', emoji: '🎲', mode: 'times', dates: ['2026-10-04', '2026-10-03'],
  startTime: '18:00', endTime: '21:00', slotMinutes: 30, timezone: 'America/Chicago', ...extra,
});

test('create, fetch, respond, and lock a MeetCute', async () => {
  const created = await newMc();
  assert.equal(created.status, 201);
  const { meetcute, adminKey } = created.json;
  assert.ok(adminKey);
  assert.equal(meetcute.adminKey, undefined, 'admin key must not leak');
  assert.deepEqual(meetcute.dates, ['2026-10-03', '2026-10-04']);

  const got = await call('GET', `/api/meetcutes/${meetcute.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.meetcute.adminKey, undefined);

  const r1 = await call('PUT', `/api/meetcutes/${meetcute.id}/responses`, { name: 'Sam', yes: ['2026-10-03T18:00'], maybe: ['2026-10-03T18:30', '2026-10-03T18:00'] });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.meetcute.responses.length, 1);
  assert.deepEqual(r1.json.meetcute.responses[0].maybe, ['2026-10-03T18:30'], 'yes wins over maybe');

  // Same name (any case) updates instead of duplicating.
  const r2 = await call('PUT', `/api/meetcutes/${meetcute.id}/responses`, { name: 'sam', yes: ['2026-10-04T20:30'] });
  assert.equal(r2.json.meetcute.responses.length, 1);
  assert.deepEqual(r2.json.meetcute.responses[0].yes, ['2026-10-04T20:30']);

  const badSlot = await call('PUT', `/api/meetcutes/${meetcute.id}/responses`, { name: 'Jo', yes: ['2026-10-04T21:00'] });
  assert.equal(badSlot.status, 400);

  const noName = await call('PUT', `/api/meetcutes/${meetcute.id}/responses`, { name: '  ', yes: [] });
  assert.equal(noName.status, 400);

  const lockNoKey = await call('POST', `/api/meetcutes/${meetcute.id}/lock`, { slots: ['2026-10-04T20:30'] });
  assert.equal(lockNoKey.status, 403);
  const lockWrong = await call('POST', `/api/meetcutes/${meetcute.id}/lock`, { slots: ['2026-10-04T20:30'] }, { 'X-Admin-Key': 'nope' });
  assert.equal(lockWrong.status, 403);
  const twoDays = await call('POST', `/api/meetcutes/${meetcute.id}/lock`, { slots: ['2026-10-03T20:30', '2026-10-04T20:30'] }, { 'X-Admin-Key': adminKey });
  assert.equal(twoDays.status, 400);
  const locked = await call('POST', `/api/meetcutes/${meetcute.id}/lock`, { slots: ['2026-10-04T20:30'] }, { 'X-Admin-Key': adminKey });
  assert.equal(locked.status, 200);
  assert.deepEqual(locked.json.meetcute.locked.slots, ['2026-10-04T20:30']);
  const unlocked = await call('POST', `/api/meetcutes/${meetcute.id}/lock`, { slots: null }, { 'X-Admin-Key': adminKey });
  assert.equal(unlocked.json.meetcute.locked, null);

  const rid = r2.json.meetcute.responses[0].id;
  assert.equal((await call('DELETE', `/api/meetcutes/${meetcute.id}/responses/${rid}`)).status, 403);
  const del = await call('DELETE', `/api/meetcutes/${meetcute.id}/responses/${rid}`, null, { 'X-Admin-Key': adminKey });
  assert.equal(del.json.meetcute.responses.length, 0);
});

test('rejects bad MeetCutes', async () => {
  assert.equal((await newMc({ title: '' })).status, 400);
  assert.equal((await newMc({ dates: [] })).status, 400);
  assert.equal((await newMc({ dates: ['2026-02-30'] })).status, 400);
  assert.equal((await newMc({ startTime: '21:00', endTime: '18:00' })).status, 400);
  assert.equal((await newMc({ slotMinutes: 7 })).status, 400);
  assert.equal((await newMc({ mode: 'weird' })).status, 400);
  const datesOnly = await newMc({ mode: 'dates', startTime: undefined });
  assert.equal(datesOnly.status, 201);
  assert.equal(datesOnly.json.meetcute.startTime, undefined);
});

test('different hours per day', async () => {
  const dayTimes = { '2026-10-04': { startTime: '10:00', endTime: '12:00' } };
  const { status, json } = await newMc({ dayTimes });
  assert.equal(status, 201);
  assert.deepEqual(json.meetcute.dayTimes, dayTimes);
  const id = json.meetcute.id;
  const ok = await call('PUT', `/api/meetcutes/${id}/responses`, { name: 'A', yes: ['2026-10-04T10:30', '2026-10-03T18:00'] });
  assert.equal(ok.status, 200);
  const outside = await call('PUT', `/api/meetcutes/${id}/responses`, { name: 'B', yes: ['2026-10-04T18:00'] });
  assert.equal(outside.status, 400, 'usual hours do not apply to a day with its own hours');
  assert.equal((await newMc({ dayTimes: { '2026-12-25': { startTime: '10:00', endTime: '12:00' } } })).status, 400);
  assert.equal((await newMc({ dayTimes: { '2026-10-04': { startTime: '12:00', endTime: '10:00' } } })).status, 400);
  assert.equal((await newMc({ dayTimes: { '2026-10-04': { startTime: '10:15', endTime: '12:00' } } })).status, 400);
  assert.equal((await newMc({ dayTimes: [] })).status, 400);
  assert.equal((await newMc({ mode: 'dates', dayTimes })).json.meetcute.dayTimes, undefined, 'ignored for dates-only');
});

test('unknown MeetCute is a friendly 404', async () => {
  const r = await call('GET', '/api/meetcutes/doesnotexist');
  assert.equal(r.status, 404);
  assert.match(r.json.error, /group chat/);
});

test('share page gets link-preview tags with the escaped title', async () => {
  const { json } = await newMc({ title: '<Pizza> & "Friends"' });
  const page = await call('GET', `/?m=${json.meetcute.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /og:title" content="&lt;Pizza&gt; &amp; &quot;Friends&quot; · MeetCute"/);
  assert.match(page.text, /<title>&lt;Pizza&gt;/);
  const home = await call('GET', '/');
  assert.match(home.text, /<title>MeetCute · Find a time that works for everyone<\/title>/);
  const old = await fetch(`${base}/m/${json.meetcute.id}`, { redirect: 'manual' });
  assert.equal(old.status, 302);
  assert.equal(old.headers.get('location'), `/?m=${json.meetcute.id}`);
});

test('static files are served and path traversal is blocked', async () => {
  assert.equal((await call('GET', '/app.js')).status, 200);
  assert.equal((await call('GET', '/config.js')).text, 'window.MEETCUTE_CONFIG = {};\n', 'local server ignores the Supabase config');
  assert.equal((await call('GET', '/../server.js')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
});
