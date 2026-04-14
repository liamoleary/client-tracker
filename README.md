# Client Tracker

A simple project time tracker with hourly Web Push check-ins and auto-stop
after 2 hours of silence. Built with Node.js, Express, SQLite
(`better-sqlite3`), and `web-push`. Designed to deploy on Railway with a
mounted volume for SQLite persistence.

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Generate VAPID keys for Web Push
npx web-push generate-vapid-keys

# 3. Copy env template and fill in the keys
cp .env.example .env
# Then edit .env and paste in VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL

# 4. Start the server
npm start
```

The server listens on `http://localhost:3000`.

### Health check

```bash
curl http://localhost:3000/health
# -> {"status":"ok"}
```

## Environment variables

| Variable            | Description                                        |
| ------------------- | -------------------------------------------------- |
| `PORT`              | Port to listen on. Railway sets this automatically.|
| `VAPID_PUBLIC_KEY`  | Web Push VAPID public key.                         |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key.                        |
| `VAPID_EMAIL`       | Contact email used as the VAPID `mailto:` subject. |

## Generating VAPID keys

```bash
npx web-push generate-vapid-keys
```

This prints a `Public Key` and `Private Key`. Put them in `.env` (or into
Railway's env vars) as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Set
`VAPID_EMAIL` to an address you control.

## Deploying to Railway

1. Push this repo to GitHub.
2. In Railway, create a new project **from the GitHub repo**. Railway will
   detect the `Dockerfile` and build from it.
3. Under the service's **Variables** tab, add:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_EMAIL`
4. Under the service's **Settings → Volumes**, create a new volume mounted
   at `/app/data`. This is where the SQLite database lives, and the volume
   keeps it intact across redeploys.
5. Deploy. Railway will expose a public URL — open it to check `/health`.

## Project layout

```
/public      static frontend (index.html, app.js, style.css, sw.js)
/data        SQLite database lives here (mount a Railway volume here)
server.js    Express app + API + cron job
```
