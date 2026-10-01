-- MeetCute database setup for Supabase.
--
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- It is safe to run again later (for example after an update).
--
-- Browsers never read or write the tables directly: row level security is on
-- with no policies. Everything goes through the functions at the bottom, which
-- validate input and keep each MeetCute's organizer key secret.

create schema if not exists meetcute_private;
revoke all on schema meetcute_private from public;

create table if not exists public.meetcutes (
  id           text primary key,
  admin_key    text not null,
  title        text not null,
  description  text not null default '',
  host         text not null default '',
  emoji        text not null default '🙌',
  mode         text not null check (mode in ('dates', 'times')),
  dates        date[] not null,
  start_time   text,
  end_time     text,
  slot_minutes int,
  timezone     text not null default 'UTC',
  locked       jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists public.responses (
  id          text primary key,
  meetcute_id text not null references public.meetcutes (id) on delete cascade,
  name        text not null,
  name_key    text not null,
  yes         text[] not null default '{}',
  maybe       text[] not null default '{}',
  note        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (meetcute_id, name_key)
);

alter table public.meetcutes enable row level security;
alter table public.responses enable row level security;
revoke all on public.meetcutes, public.responses from anon, authenticated;

-- ---------- helpers (not callable from the browser) ----------

create or replace function meetcute_private.fail(msg text) returns void
language plpgsql as $$ begin raise exception using message = msg; end $$;

-- Strip control characters, trim, and enforce a length limit.
create or replace function meetcute_private.clean(v text, max_len int, label text, required boolean default false)
returns text language plpgsql immutable as $$
declare out text := btrim(regexp_replace(coalesce(v, ''), '[\x01-\x08\x0B-\x1F\x7F]', '', 'g'));
begin
  if required and out = '' then perform meetcute_private.fail(label || ' is required'); end if;
  if char_length(out) > max_len then perform meetcute_private.fail(label || ' must be ' || max_len || ' characters or fewer'); end if;
  return out;
end $$;

-- "HH:MM" -> minutes since midnight, or null if invalid. "24:00" is allowed.
create or replace function meetcute_private.tmin(t text) returns int
language plpgsql immutable as $$
declare h int; m int;
begin
  if t is null or t !~ '^\d{2}:\d{2}$' then return null; end if;
  h := split_part(t, ':', 1)::int; m := split_part(t, ':', 2)::int;
  if h > 24 or m > 59 or (h = 24 and m <> 0) then return null; end if;
  return h * 60 + m;
end $$;

create or replace function meetcute_private.is_date(s text) returns boolean
language plpgsql immutable as $$
begin
  if s is null or s !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  return to_char(s::date, 'YYYY-MM-DD') = s;
exception when others then return false;
end $$;

-- Every selectable option, in the same format the app uses:
-- "2026-10-04" for dates, "2026-10-04T14:30" for times.
create or replace function meetcute_private.slot_ids(m public.meetcutes) returns text[]
language sql stable as $$
  select case when m.mode = 'dates' then
    (select coalesce(array_agg(to_char(d, 'YYYY-MM-DD') order by d), '{}') from unnest(m.dates) d)
  else
    (select coalesce(array_agg(to_char(d, 'YYYY-MM-DD') || 'T' || lpad((t / 60)::text, 2, '0') || ':' || lpad((t % 60)::text, 2, '0') order by d, t), '{}')
       from unnest(m.dates) d,
            generate_series(meetcute_private.tmin(m.start_time), meetcute_private.tmin(m.end_time) - m.slot_minutes, m.slot_minutes) t)
  end
$$;

-- A JSON list of strings -> deduplicated text[] (or an error).
create or replace function meetcute_private.str_list(v jsonb, label text) returns text[]
language plpgsql immutable as $$
declare out text[];
begin
  if v is null or jsonb_typeof(v) = 'null' then return '{}'; end if;
  if jsonb_typeof(v) <> 'array' then perform meetcute_private.fail(label || ' must be a list'); end if;
  if exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
    perform meetcute_private.fail(label || ' must be a list of text');
  end if;
  select coalesce(array_agg(distinct e), '{}') into out from jsonb_array_elements_text(v) e;
  return out;
end $$;

create or replace function meetcute_private.new_id(len int) returns text
language sql volatile as $$ select substr(replace(gen_random_uuid()::text, '-', ''), 1, len) $$;

-- Public view of a MeetCute, without the organizer key.
create or replace function meetcute_private.view(p_id text) returns jsonb
language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', m.id, 'title', m.title, 'description', m.description, 'host', m.host, 'emoji', m.emoji,
    'mode', m.mode,
    'dates', (select jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d) from unnest(m.dates) d),
    'startTime', m.start_time, 'endTime', m.end_time, 'slotMinutes', m.slot_minutes,
    'timezone', m.timezone, 'locked', m.locked, 'createdAt', m.created_at,
    'responses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'yes', to_jsonb(r.yes), 'maybe', to_jsonb(r.maybe), 'note', r.note,
        'createdAt', r.created_at, 'updatedAt', r.updated_at) order by r.created_at, r.id)
      from public.responses r where r.meetcute_id = m.id), '[]'::jsonb)))
  from public.meetcutes m where m.id = p_id
$$;

create or replace function meetcute_private.find(p_id text) returns public.meetcutes
language plpgsql stable as $$
declare m public.meetcutes;
begin
  select * into m from public.meetcutes where id = p_id;
  if not found then perform meetcute_private.fail('We couldn''t find that MeetCute. Maybe it got lost in the group chat? 🤷'); end if;
  return m;
end $$;

create or replace function meetcute_private.check_admin(m public.meetcutes, p_admin_key text) returns void
language plpgsql as $$
begin
  if p_admin_key is null or p_admin_key <> m.admin_key then
    perform meetcute_private.fail('Only the organizer can do that');
  end if;
end $$;

-- ---------- API (callable from the browser) ----------

create or replace function public.create_meetcute(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.meetcutes;
  date_strs text[];
  s text;
  start_m int; end_m int;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then perform meetcute_private.fail('Missing body'); end if;

  m.title := meetcute_private.clean(payload->>'title', 80, 'Name', true);
  m.description := meetcute_private.clean(payload->>'description', 500, 'Description');
  m.host := meetcute_private.clean(payload->>'host', 40, 'Your name');
  m.emoji := coalesce(nullif(meetcute_private.clean(payload->>'emoji', 16, 'Emoji'), ''), '🙌');

  m.mode := payload->>'mode';
  if m.mode is null or m.mode not in ('dates', 'times') then perform meetcute_private.fail('Mode must be "dates" or "times"'); end if;

  date_strs := meetcute_private.str_list(payload->'dates', 'dates');
  if cardinality(date_strs) = 0 then perform meetcute_private.fail('Pick at least one date'); end if;
  if cardinality(date_strs) > 60 then perform meetcute_private.fail('Pick 60 dates or fewer'); end if;
  foreach s in array date_strs loop
    if not meetcute_private.is_date(s) then perform meetcute_private.fail('One of those dates looks off'); end if;
  end loop;
  select array_agg(d::date order by d) into m.dates from unnest(date_strs) d;

  m.timezone := coalesce(payload->>'timezone', 'UTC');
  if not exists (select 1 from pg_timezone_names where name = m.timezone) then m.timezone := 'UTC'; end if;

  if m.mode = 'times' then
    m.start_time := payload->>'startTime';
    m.end_time := payload->>'endTime';
    start_m := meetcute_private.tmin(m.start_time);
    end_m := meetcute_private.tmin(m.end_time);
    if start_m is null or end_m is null then perform meetcute_private.fail('Times must look like HH:MM'); end if;
    if jsonb_typeof(payload->'slotMinutes') is distinct from 'number' or (payload->>'slotMinutes') not in ('15', '30', '60') then
      perform meetcute_private.fail('Slot length must be 15, 30 or 60 minutes');
    end if;
    m.slot_minutes := (payload->>'slotMinutes')::int;
    if start_m % m.slot_minutes <> 0 or end_m % m.slot_minutes <> 0 then perform meetcute_private.fail('Times must line up with the slot length'); end if;
    if end_m - start_m < m.slot_minutes then perform meetcute_private.fail('End time must be after start time'); end if;
    if cardinality(m.dates) * ((end_m - start_m) / m.slot_minutes) > 2500 then
      perform meetcute_private.fail('That is a lot of slots! Try fewer dates or a shorter window.');
    end if;
  end if;

  m.admin_key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  m.created_at := now();
  loop
    m.id := meetcute_private.new_id(10);
    exit when not exists (select 1 from public.meetcutes where id = m.id);
  end loop;
  insert into public.meetcutes select m.*;

  return jsonb_build_object('meetcute', meetcute_private.view(m.id), 'adminKey', m.admin_key);
end $$;

create or replace function public.get_meetcute(p_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform meetcute_private.find(p_id);
  return jsonb_build_object('meetcute', meetcute_private.view(p_id));
end $$;

create or replace function public.upsert_response(p_id text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.meetcutes := meetcute_private.find(p_id);
  valid text[];
  v_name text; v_note text; v_yes text[]; v_maybe text[];
  bad text;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then perform meetcute_private.fail('Missing body'); end if;
  v_name := meetcute_private.clean(payload->>'name', 40, 'Name', true);
  v_note := meetcute_private.clean(payload->>'note', 140, 'Note');
  v_yes := meetcute_private.str_list(payload->'yes', 'yes');
  v_maybe := meetcute_private.str_list(payload->'maybe', 'maybe');
  valid := meetcute_private.slot_ids(m);
  select x into bad from unnest(v_yes || v_maybe) x where not (x = any (valid)) limit 1;
  if bad is not null then perform meetcute_private.fail('"' || left(bad, 20) || '" is not one of the options'); end if;
  select coalesce(array_agg(x order by x), '{}') into v_maybe from unnest(v_maybe) x where not (x = any (v_yes));
  select coalesce(array_agg(x order by x), '{}') into v_yes from unnest(v_yes) x;

  if not exists (select 1 from public.responses where meetcute_id = m.id and name_key = lower(v_name))
     and (select count(*) from public.responses where meetcute_id = m.id) >= 200 then
    perform meetcute_private.fail('This MeetCute is full!');
  end if;

  insert into public.responses (id, meetcute_id, name, name_key, yes, maybe, note)
  values (meetcute_private.new_id(12), m.id, v_name, lower(v_name), v_yes, v_maybe, v_note)
  on conflict (meetcute_id, name_key) do update
    set name = excluded.name, yes = excluded.yes, maybe = excluded.maybe, note = excluded.note, updated_at = now();

  return jsonb_build_object('meetcute', meetcute_private.view(m.id));
end $$;

create or replace function public.delete_response(p_id text, p_admin_key text, p_response_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.meetcutes := meetcute_private.find(p_id);
begin
  perform meetcute_private.check_admin(m, p_admin_key);
  delete from public.responses where meetcute_id = m.id and id = p_response_id;
  if not found then perform meetcute_private.fail('No such response'); end if;
  return jsonb_build_object('meetcute', meetcute_private.view(m.id));
end $$;

create or replace function public.lock_meetcute(p_id text, p_admin_key text, p_slots jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.meetcutes := meetcute_private.find(p_id);
  v_slots text[];
begin
  perform meetcute_private.check_admin(m, p_admin_key);
  v_slots := meetcute_private.str_list(p_slots, 'slots');
  if cardinality(v_slots) = 0 then
    update public.meetcutes set locked = null where id = m.id;
  else
    if exists (select 1 from unnest(v_slots) x where not (x = any (meetcute_private.slot_ids(m)))) then
      perform meetcute_private.fail('That is not one of the options');
    end if;
    if (select count(distinct left(x, 10)) from unnest(v_slots) x) <> 1 then
      perform meetcute_private.fail('Pick a time on a single day');
    end if;
    update public.meetcutes
      set locked = jsonb_build_object('slots', (select jsonb_agg(x order by x) from unnest(v_slots) x), 'at', now())
      where id = m.id;
  end if;
  return jsonb_build_object('meetcute', meetcute_private.view(m.id));
end $$;

-- Only the five API functions are callable from the browser.
revoke all on all functions in schema meetcute_private from public, anon, authenticated;
revoke all on function public.create_meetcute(jsonb), public.get_meetcute(text), public.upsert_response(text, jsonb),
  public.delete_response(text, text, text), public.lock_meetcute(text, text, jsonb) from public;
grant execute on function public.create_meetcute(jsonb), public.get_meetcute(text), public.upsert_response(text, jsonb),
  public.delete_response(text, text, text), public.lock_meetcute(text, text, jsonb) to anon, authenticated;
