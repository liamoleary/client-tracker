# Client Tracker

A single-user project time tracker with hourly Web Push check-ins and a
2-hour auto-stop safety net. Runs as a single Node.js service (Express +
SQLite via `better-sqlite3`), designed to deploy on **Railway** with a
mounted volume for SQLite persistence.

## Features

- Add projects and start/stop per-project timers from a mobile-friendly UI
- Sticky active-timer banner with a live `HH:MM:SS` ticker
- Web Push notifications every hour asking "Still working on X?" with
  `Yes, still working` / `No, stop timer` actions
- Auto-stops the timer if you go silent for 2 hours (end_time is set to
  `last_notified_at + 2h` so the recorded duration is honest)

---

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Generate VAPID keys for Web Push
npx web-push generate-vapid-keys

# 3. Copy env template and fill in the keys
cp .env.example .env
# Edit .env and paste in VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL

# 4. Start the server
npm start
```

Open `http://localhost:3000`. Health check: `GET /health` → `{"status":"ok"}`.

### Environment variables

| Variable            | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `PORT`              | Port to listen on. Railway sets this automatically.  |
| `VAPID_PUBLIC_KEY`  | Web Push VAPID public key.                           |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key.                          |
| `VAPID_EMAIL`       | Contact email used as the VAPID `mailto:` subject.   |

If the VAPID vars are not set, the server still runs but push notifications
are disabled (useful for local dev without keys).

### Generating VAPID keys

```bash
npx web-push generate-vapid-keys
```

Prints a `Public Key` and `Private Key`. Put them in `.env` (or into
Railway's env vars) as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Set
`VAPID_EMAIL` to an address you control.

---

## Railway deployment

1. **Push this repo to GitHub.**

2. **Create a Railway project** from the GitHub repo (Railway detects the
   `Dockerfile` automatically).

3. **Set environment variables** on the service (Variables tab):

   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_EMAIL`

   (Do **not** set `PORT` — Railway provides it.)

4. **Add a Volume** so SQLite survives redeploys:

   - Service → Settings → Volumes → **New Volume**
   - Mount path: `/app/data`
   - Any small size (1 GB is plenty)

5. **Deploy.** Railway builds the Dockerfile and starts the service.
   Open the generated public URL and hit `/health`.

6. **Enable notifications** on your phone:

   - Open the public URL on your phone's browser (Chrome / Edge / Android
     Firefox all support Web Push; iOS 16.4+ Safari requires adding the
     app to the Home Screen first).
   - Tap **Enable Notifications** in the banner.
   - Grant permission. You'll receive a push every hour that a timer is
     running.

### Data persistence

SQLite lives at `/app/data/db.sqlite` inside the container. With the volume
mounted at `/app/data`, the database survives redeploys and container
restarts. The `/app/data` directory is also created automatically on
startup if it doesn't exist (`fs.mkdirSync(..., { recursive: true })`).

---

## Project layout

```
/public              static frontend
  index.html         layout + banners
  app.js             UI logic, timer ticker, push subscription
  style.css          dark neutral theme, mobile-responsive
  sw.js              service worker: push handler + notification actions
/routes
  projects.js        GET/POST /api/projects
  timer.js           GET /api/timer/active, POST /api/timer/{start,stop,confirm}
  push.js            POST /api/push/subscribe, GET /api/push/vapid-public-key
  sessions.js        GET /api/sessions/:project_id
/jobs
  timerMonitor.js    node-cron: hourly push + 2h auto-stop
/data                SQLite lives here (mount a Railway volume here)
db.js                better-sqlite3 instance + initDB()
server.js            Express app wiring
Dockerfile           node:18-alpine build
```

## API reference

| Method | Path                          | Description                                          |
| ------ | ----------------------------- | ---------------------------------------------------- |
| GET    | `/health`                     | `{ status: "ok" }`                                   |
| GET    | `/api/projects`               | All projects with computed `total_seconds`           |
| POST   | `/api/projects`               | Create project `{ name }`                            |
| GET    | `/api/timer/active`           | Running session (+ `project_name`) or `null`         |
| POST   | `/api/timer/start`            | `{ project_id }` — 400 if already running            |
| POST   | `/api/timer/stop`             | Stop active session, set `duration_seconds`         |
| POST   | `/api/timer/confirm`          | Reset `last_notified_at` on active session           |
| GET    | `/api/sessions/:project_id`   | All completed sessions for a project (newest first) |
| GET    | `/api/push/vapid-public-key`  | `{ key }` — public VAPID key                         |
| POST   | `/api/push/subscribe`         | Save Web Push subscription                           |
