require('dotenv').config();

const express = require('express');
const path = require('path');

const { initDB } = require('./db');
const projectsRouter = require('./routes/projects');
const { router: timerRouter } = require('./routes/timer');
const { router: pushRouter, configureWebPush } = require('./routes/push');
const sessionsRouter = require('./routes/sessions');
const timerMonitor = require('./jobs/timerMonitor');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialise SQLite (creates the data directory and tables if needed).
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
app.use('/api/sessions', sessionsRouter);

// Start the background monitor (hourly check-in + 2h auto-stop).
timerMonitor.start();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
