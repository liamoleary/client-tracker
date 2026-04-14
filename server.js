require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const { initDB } = require('./db');
const projectsRouter = require('./routes/projects');
const { router: timerRouter } = require('./routes/timer');
const { router: pushRouter, configureWebPush } = require('./routes/push');
const timerMonitor = require('./jobs/timerMonitor');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure /data directory exists (for SQLite)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialise SQLite (creates tables if they don't exist).
initDB();

// Configure web-push from VAPID env vars (no-op with warning if unset).
configureWebPush();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api/projects', projectsRouter);
app.use('/api/timer', timerRouter);
app.use('/api/push', pushRouter);

// Start the background monitor (hourly check-in + 2h auto-stop).
timerMonitor.start();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
