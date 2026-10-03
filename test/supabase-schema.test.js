'use strict';
// Exercises supabase/schema.sql against a real Postgres, calling the API as the
// restricted "anon" role the browser uses. Skipped unless MEETCUTE_TEST_PG is set
// to psql connection args, e.g. MEETCUTE_TEST_PG="-h /path/to/socket -p 5499 -U postgres".
// The database needs "anon" and "authenticated" roles (Supabase has them built in).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const S = require('../public/slots.js');

const PG = process.env.MEETCUTE_TEST_PG;
const skip = PG ? false : 'set MEETCUTE_TEST_PG to run the database tests';
const adminArgs = PG ? PG.split(/\s+/).filter(Boolean) : [];
const SCHEMA_FILE = path.join(__dirname, '..', 'supabase', 'schema.sql');

// Each run gets fresh databases so leftovers never hide a problem.
const dbName = (tag) => `meetcute_test_${tag}_${process.pid}`;
function freshDb(tag) {
  const name = dbName(tag);
  execFileSync('psql', [...adminArgs, '-X', '-q', '-d', 'postgres', '-c', `drop database if exists ${name}`, '-c', `create database ${name}`], { stdio: 'pipe' });
  return [...adminArgs, '-d', name];
}
const dropDb = (tag) => execFileSync('psql', [...adminArgs, '-X', '-q', '-d', 'postgres', '-c', `drop database if exists ${dbName(tag)}`], { stdio: 'pipe' });

let pgArgs = [];
function psql(sql, args = pgArgs) {
  return execFileSync('psql', [...args, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function applySchema(args = pgArgs) {
  try {
    execFileSync('psql', [...args, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', SCHEMA_FILE], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const m = /ERROR:\s+(.*)/.exec(String(e.stderr || e.message));
    throw new Error(m ? m[1] : String(e));
  }
}

const lit = (v) => '$mc$' + (typeof v === 'string' ? v : JSON.stringify(v)) + '$mc$';

// Calls an API function as anon; returns parsed JSON or throws with the Postgres message.
function rpc(fn, ...args) {
  const sqlArgs = args.map((a) => (a === null ? 'null' : typeof a === 'string' ? lit(a) + '::text' : lit(a) + '::jsonb')).join(', ');
  try {
    return JSON.parse(psql(`set role anon; select public.${fn}(${sqlArgs});`));
  } catch (e) {
    const m = /ERROR:\s+(.*)/.exec(String(e.stderr || e.message));
    throw new Error(m ? m[1] : String(e));
  }
}

const base = {
  title: 'Game Night', emoji: '🎲', mode: 'times', dates: ['2026-10-04', '2026-10-03'],
  startTime: '18:00', endTime: '21:00', slotMinutes: 30, timezone: 'America/Chicago',
};

test.after(() => { if (PG) { dropDb('main'); dropDb('clash'); dropDb('upgrade'); } });

test('applies next to an existing app without touching it, and can be re-run', { skip }, () => {
  pgArgs = freshDb('main');
  // Pretend this Supabase project already runs another app with a "responses" table.
  psql(`create table public.responses (id serial primary key, answer text);
        insert into public.responses (answer) values ('keep me');
        grant select, insert on public.responses to anon;
        create function public.other_app_fn() returns int language sql as 'select 1';
        grant execute on function public.other_app_fn() to anon;`);
  applySchema();
  applySchema();
  assert.equal(psql("set role anon; select answer from public.responses;"), 'keep me', 'existing table and its grants are untouched');
  assert.equal(psql("set role anon; select public.other_app_fn();"), '1', 'existing functions still work');
  assert.equal(psql("select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'responses';"), '2');
});

test('stops without changing anything if a public function name clashes', { skip }, () => {
  const args = freshDb('clash');
  psql("create function public.get_meetcute(x int) returns int language sql as 'select x';", args);
  assert.throws(() => applySchema(args), /already has function\(s\) named get_meetcute/);
  assert.equal(psql("select count(*) from pg_namespace where nspname = 'meetcute';", args), '0');
  assert.equal(psql("select public.get_meetcute(7);", args), '7');
});

test('create, fetch, respond, lock and delete through the API', { skip }, () => {
  const { meetcute, adminKey } = rpc('create_meetcute', base);
  assert.ok(adminKey && adminKey.length >= 32);
  assert.equal(meetcute.adminKey, undefined);
  assert.equal(JSON.stringify(meetcute).includes(adminKey), false, 'admin key must not leak');
  assert.deepEqual(meetcute.dates, ['2026-10-03', '2026-10-04']);
  assert.equal(meetcute.slotMinutes, 30);
  assert.equal(meetcute.timezone, 'America/Chicago');
  assert.deepEqual(meetcute.responses, []);

  const got = rpc('get_meetcute', meetcute.id).meetcute;
  assert.equal(got.title, 'Game Night');

  let mc = rpc('upsert_response', meetcute.id, { name: 'Sam', yes: ['2026-10-03T18:00'], maybe: ['2026-10-03T18:30', '2026-10-03T18:00'], note: 'hi' }).meetcute;
  assert.equal(mc.responses.length, 1);
  assert.deepEqual(mc.responses[0].maybe, ['2026-10-03T18:30'], 'yes wins over maybe');

  mc = rpc('upsert_response', meetcute.id, { name: 'SAM', yes: ['2026-10-04T20:30'] }).meetcute;
  assert.equal(mc.responses.length, 1, 'same name (any case) updates');
  assert.deepEqual(mc.responses[0].yes, ['2026-10-04T20:30']);
  assert.equal(mc.responses[0].name, 'SAM');

  assert.throws(() => rpc('upsert_response', meetcute.id, { name: 'Jo', yes: ['2026-10-04T21:00'] }), /not one of the options/);
  assert.throws(() => rpc('upsert_response', meetcute.id, { name: '  ', yes: [] }), /Name is required/);
  assert.throws(() => rpc('upsert_response', meetcute.id, { name: 'Jo', yes: 'nope' }), /must be a list/);

  assert.throws(() => rpc('lock_meetcute', meetcute.id, 'wrong', ['2026-10-04T20:30']), /Only the organizer/);
  assert.throws(() => rpc('lock_meetcute', meetcute.id, adminKey, ['2026-10-03T20:30', '2026-10-04T20:30']), /single day/);
  mc = rpc('lock_meetcute', meetcute.id, adminKey, ['2026-10-04T20:30', '2026-10-04T20:00']).meetcute;
  assert.deepEqual(mc.locked.slots, ['2026-10-04T20:00', '2026-10-04T20:30']);
  assert.equal(rpc('lock_meetcute', meetcute.id, adminKey, null).meetcute.locked, undefined);
  rpc('lock_meetcute', meetcute.id, adminKey, ['2026-10-04T20:30']);
  assert.equal(rpc('lock_meetcute', meetcute.id, adminKey, []).meetcute.locked, undefined);

  const rid = mc.responses[0].id;
  assert.throws(() => rpc('delete_response', meetcute.id, 'wrong', rid), /Only the organizer/);
  assert.deepEqual(rpc('delete_response', meetcute.id, adminKey, rid).meetcute.responses, []);
});

test('valid options match the app’s own slot list', { skip }, () => {
  for (const extra of [{}, { startTime: '00:00', endTime: '24:00', slotMinutes: 60 }, { mode: 'dates' }]) {
    const fields = { ...base, ...extra };
    const { meetcute } = rpc('create_meetcute', fields);
    const all = S.slotIds(meetcute);
    const mc = rpc('upsert_response', meetcute.id, { name: 'All', yes: all }).meetcute;
    assert.deepEqual(mc.responses[0].yes, all.slice().sort());
  }
});

test('different hours per day', { skip }, () => {
  const dayTimes = { '2026-10-04': { startTime: '10:00', endTime: '12:00' } };
  const { meetcute } = rpc('create_meetcute', { ...base, dayTimes });
  assert.deepEqual(meetcute.dayTimes, dayTimes);
  const all = S.slotIds(meetcute);
  assert.ok(all.includes('2026-10-04T10:00') && !all.includes('2026-10-04T18:00'));
  const mc = rpc('upsert_response', meetcute.id, { name: 'All', yes: all }).meetcute;
  assert.deepEqual(mc.responses[0].yes, all.slice().sort(), 'database and app agree on every option');
  assert.throws(() => rpc('upsert_response', meetcute.id, { name: 'B', yes: ['2026-10-04T18:00'] }), /not one of the options/);
  assert.throws(() => rpc('create_meetcute', { ...base, dayTimes: { '2026-12-25': { startTime: '10:00', endTime: '12:00' } } }), /one of the picked dates/);
  assert.throws(() => rpc('create_meetcute', { ...base, dayTimes: { '2026-10-04': { startTime: '12:00', endTime: '10:00' } } }), /after start/);
  assert.throws(() => rpc('create_meetcute', { ...base, dayTimes: { '2026-10-04': { startTime: '10:15', endTime: '12:00' } } }), /line up/);
  assert.throws(() => rpc('create_meetcute', { ...base, dayTimes: [] }), /must be an object/);
  assert.equal(rpc('create_meetcute', base).meetcute.dayTimes, undefined);
});

test('upgrading a database set up with the previous script keeps its data', { skip }, () => {
  const args = freshDb('upgrade');
  // The script as it was before per-day hours, i.e. what an existing Supabase project already ran.
  const old = require('node:fs').readFileSync(path.join(__dirname, 'fixtures', 'schema-before-day-times.sql'), 'utf8');
  execFileSync('psql', [...args, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: old, stdio: ['pipe', 'pipe', 'pipe'] });
  const before = JSON.parse(psql(`set role anon; select public.create_meetcute(${lit(base)}::jsonb);`, args));
  applySchema(args);
  const after = JSON.parse(psql(`set role anon; select public.get_meetcute(${lit(before.meetcute.id)}::text);`, args));
  assert.equal(after.meetcute.title, 'Game Night');
  const withDays = JSON.parse(psql(`set role anon; select public.create_meetcute(${lit({ ...base, dayTimes: { '2026-10-04': { startTime: '10:00', endTime: '12:00' } } })}::jsonb);`, args));
  assert.ok(withDays.meetcute.dayTimes);
});

test('rejects bad MeetCutes', { skip }, () => {
  assert.throws(() => rpc('create_meetcute', { ...base, title: '' }), /Name is required/);
  assert.throws(() => rpc('create_meetcute', { ...base, title: 'x'.repeat(81) }), /80 characters/);
  assert.throws(() => rpc('create_meetcute', { ...base, dates: [] }), /at least one date/);
  assert.throws(() => rpc('create_meetcute', { ...base, dates: ['2026-02-30'] }), /looks off/);
  assert.throws(() => rpc('create_meetcute', { ...base, startTime: '21:00', endTime: '18:00' }), /after start/);
  assert.throws(() => rpc('create_meetcute', { ...base, slotMinutes: 7 }), /15, 30 or 60/);
  assert.throws(() => rpc('create_meetcute', { ...base, mode: 'weird' }), /Mode/);
  const { meetcute } = rpc('create_meetcute', { ...base, mode: 'dates', timezone: 'Not/AZone' });
  assert.equal(meetcute.startTime, undefined);
  assert.equal(meetcute.timezone, 'UTC');
});

test('unknown MeetCute is a friendly error', { skip }, () => {
  assert.throws(() => rpc('get_meetcute', 'doesnotexist'), /lost in the group chat/);
});

test('the browser role cannot touch tables or helpers directly', { skip }, () => {
  assert.throws(() => psql('set role anon; select * from meetcute.meetcutes;'), /permission denied/);
  assert.throws(() => psql('set role anon; select admin_key from meetcute.meetcutes;'), /permission denied/);
  assert.throws(() => psql("set role anon; insert into meetcute.responses (id, meetcute_id, name, name_key) values ('a','b','c','c');"), /permission denied/);
  assert.throws(() => psql("set role anon; select meetcute.new_id(5);"), /permission denied/);
});
