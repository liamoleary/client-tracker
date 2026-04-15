require('dotenv').config();

const express = require('express');
const path = require('path');

const { initDB } = require('./db');
const projectsRouter = require('./routes/projects');
const { router: timerRouter } = require('./routes/timer');
const { router: pushRouter, configureWebPush } = require('./routes/push');
const sessionsRouter = require('./routes/sessions');
const backupRouter = require('./routes/backup');
const timerMonitor = require('./jobs/timerMonitor');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialise SQLite (creates the data directory and tables if needed).
initDB();

// Configure web-push from VAPID env vars (no-op with warning if unset).
configureWebPush();

// Middleware — 10mb body limit so /api/restore can accept sizeable backups.
app.use(express.json({ limit: '10mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
    },
  }),
);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api/projects', projectsRouter);
app.use('/api/timer', timerRouter);
app.use('/api/push', pushRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api', backupRouter);

// Start the background monitor (hourly check-in + 2h auto-stop).
timerMonitor.start();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
