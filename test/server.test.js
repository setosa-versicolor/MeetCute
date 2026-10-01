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

test('unknown MeetCute is a friendly 404', async () => {
  const r = await call('GET', '/api/meetcutes/doesnotexist');
  assert.equal(r.status, 404);
  assert.match(r.json.error, /dream/);
});

test('share page gets link-preview tags with the escaped title', async () => {
  const { json } = await newMc({ title: '<Pizza> & "Friends"' });
  const page = await call('GET', `/m/${json.meetcute.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /og:title" content="🎲 &lt;Pizza&gt; &amp; &quot;Friends&quot; · MeetCute"/);
  assert.doesNotMatch(page.text, /\{\{/);
});

test('static files are served and path traversal is blocked', async () => {
  assert.equal((await call('GET', '/app.js')).status, 200);
  assert.equal((await call('GET', '/../server.js')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
});
