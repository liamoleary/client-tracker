require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const { initDB } = require('./db');
const projectsRouter = require('./routes/projects');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure /data directory exists (for SQLite)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialise SQLite (creates tables if they don't exist).
initDB();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api/projects', projectsRouter);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
