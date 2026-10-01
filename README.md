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

## Running it

No dependencies. You need Node 18 or newer.

```bash
npm start          # http://localhost:3000
npm test           # API + scheduling logic tests
```

Environment variables:

| Variable    | Default                 | What it does                 |
|-------------|-------------------------|------------------------------|
| `PORT`      | `3000`                  | HTTP port                    |
| `DATA_FILE` | `./data/meetcutes.json` | Where MeetCutes are stored   |

## How it's built

- `server.js`: a small `node:http` server. It provides the JSON API, validation, file-backed storage,
  serves the static files, and fills in link-preview tags.
- `public/slots.js`: logic shared by the browser and the server. It builds the slot grid, tallies
  responses, merges and ranks windows, and handles time-zone math for calendar exports.
- `public/app.js`: the single-page front end in plain JavaScript (create, respond, results).
- `public/styles.css`: the look, with dark mode and reduced-motion support.

### API

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/meetcutes` | `{title, emoji, host, description, mode: "dates"\|"times", dates[], startTime, endTime, slotMinutes, timezone}` returns `{meetcute, adminKey}` |
| `GET` | `/api/meetcutes/:id` | returns `{meetcute}` |
| `PUT` | `/api/meetcutes/:id/responses` | `{name, yes[], maybe[], note}`. Matching by name ignores case, so the same name updates its response. |
| `DELETE` | `/api/meetcutes/:id/responses/:rid` | needs the `X-Admin-Key` header |
| `POST` | `/api/meetcutes/:id/lock` | `{slots[]}` (or `null` to unlock). Needs the `X-Admin-Key` header. |

Times are stored as wall-clock times in the creator's time zone, which is shown on the page.
People in a different time zone see a heads-up.

### Going to production

The JSON file store is fine for friends and family. For real traffic, replace `createStore` in
`server.js` with SQLite or Postgres and add rate limiting in front of the API.
