# 🙌 MeetCute

*Get the crew together.* A playful way for a group of friends to agree on when to hang out.

1. **Create**: name your MeetCute (or roll the 🎲), pick an emoji, and choose dates on the calendar.
   Ask about **dates only** or **dates & times** (with Morning / Afternoon / Evening presets and 15/30/60-minute slots).
2. **Share**: copy the link to your friends, send it by text or email, or use your phone's share sheet. Link previews show the MeetCute's name.
3. **Respond**: each person types their name and click-drags (or taps) to paint ✅ *I'm free* or 🤞 *If needed*.
   Typing the same name later brings back that person's picks so they can edit them.
4. **Best times**: a live heatmap, a "squad sync" score, and the top 3 time windows. Back-to-back slots are
   merged, so you see "Sat 2pm–4:30pm" instead of five separate rows. Slots where everyone is free get a 🙌.
5. **Lock it in 📌**: the organizer picks the winner. Everyone sees an "It's a plan!" banner with
   Add to Google Calendar and .ics download buttons.

The organizer's browser remembers that they created the MeetCute. They also get a secret **organizer link**
for using another device. With it they can lock or unlock the final time and remove responses.

## Put it online (GitHub Pages + Supabase)

GitHub Pages hosts the website. A free [Supabase](https://supabase.com) database stores everyone's responses.
You only do this once.

**1. Set up the database (about 5 minutes)**

1. Sign up at [supabase.com](https://supabase.com) and create a project, or reuse one you already have.
   MeetCute keeps its tables in its own `meetcute` schema and won't touch your other apps' tables.
2. In the project, open **SQL Editor**, click **New query**, paste in all of
   [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. It should say "Success. No rows returned".
   If your project already has a function with one of MeetCute's five function names, the script stops
   and changes nothing.
3. Open **Project Settings → API Keys** (or click **Connect**) and copy two things:
   - the **Project URL**, which looks like `https://abcdefghijklm.supabase.co`
   - the **Publishable key** (`sb_publishable_…`), or on older projects the **anon public** key
4. Put both into [`public/config.js`](public/config.js) and commit. You can edit the file right on GitHub
   with the pencil icon. Both values are safe to make public.

**2. Turn on GitHub Pages**

In the GitHub repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.

Each push to `master` runs the tests and publishes `public/` to
**https://setosa-versicolor.github.io/MeetCute/**. The **Actions** tab shows progress. If a deploy failed
before Pages was turned on, open the failed run and click **Re-run all jobs**.

> Free Supabase projects pause after a week with no visits. If the site says it can't reach the server,
> open your Supabase dashboard and click **Restore project**.

## Running it locally

No dependencies. You need Node 18 or newer. The local server ignores `public/config.js` and keeps MeetCutes
in its own file, so testing locally never touches your real Supabase data.

```bash
npm start          # http://localhost:3000
npm test           # API + scheduling logic tests
```

To also test the database script, point the tests at any Postgres that has `anon` and `authenticated` roles:
`MEETCUTE_TEST_PG="-h localhost -U postgres" npm test`. GitHub Actions does this on every push.

Environment variables:

| Variable    | Default                 | What it does                 |
|-------------|-------------------------|------------------------------|
| `PORT`      | `3000`                  | HTTP port                    |
| `DATA_FILE` | `./data/meetcutes.json` | Where MeetCutes are stored   |

## How it's built

- `supabase/schema.sql`: the online database. Tables and helpers live in a separate `meetcute` schema so
  they can share a Supabase project with other apps. Browsers can't touch the tables. They can only call five
  database functions (`create_meetcute`, `get_meetcute`, `upsert_response`, `delete_response` and
  `lock_meetcute`), which validate input and keep organizer keys secret.
- `server.js`: a small `node:http` server for local use. It has the same API backed by a JSON file, and it
  fills in link-preview tags.
- `public/slots.js`: logic shared by the browser and the server. It builds the slot grid, tallies
  responses, merges and ranks windows, and handles time-zone math for calendar exports.
- `public/app.js`: the single-page front end in plain JavaScript (create, respond, results). It uses Supabase
  when `public/config.js` is filled in (as it is on GitHub Pages), and the local server otherwise. MeetCute links look like `?m=abc123`.
- `.github/workflows/pages.yml`: runs all tests (including the database tests) and deploys to Pages.
- `public/styles.css`: the look, with dark mode and reduced-motion support.

### Local server API

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/meetcutes` | `{title, emoji, host, description, mode: "dates"\|"times", dates[], startTime, endTime, slotMinutes, timezone}` returns `{meetcute, adminKey}` |
| `GET` | `/api/meetcutes/:id` | returns `{meetcute}` |
| `PUT` | `/api/meetcutes/:id/responses` | `{name, yes[], maybe[], note}`. Matching by name ignores case, so the same name updates its response. |
| `DELETE` | `/api/meetcutes/:id/responses/:rid` | needs the `X-Admin-Key` header |
| `POST` | `/api/meetcutes/:id/lock` | `{slots[]}` (or `null` to unlock). Needs the `X-Admin-Key` header. |

Times are stored as wall-clock times in the creator's time zone, which is shown on the page.
People in a different time zone see a heads-up.

### Good to know

- On GitHub Pages, shared links preview as the generic "MeetCute" card, because static hosting can't customize
  previews for each MeetCute. Previews with the MeetCute's own name only work with the local Node server.
- Anyone with a MeetCute's link can add responses, so share links with your friends rather than posting them publicly.
