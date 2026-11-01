require('dotenv').config();
const path = require('path');

function parseIds(raw) {
  return String(raw || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => value !== '')
    .map(Number)
    .filter(value => Number.isSafeInteger(value) && value > 0);
}

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

module.exports = {
  botToken: process.env.BOT_TOKEN || '',
  adminIds: parseIds(process.env.ADMIN_IDS),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'feedback.db'),
  logLevel: process.env.LOG_LEVEL || 'info',
  // Hard cap on a single submission so nothing oversized lands in the database.
  feedbackMaxLen: parsePositiveInt(process.env.FEEDBACK_MAX_LEN, 2000),
  // Minimum seconds between two submissions from the same user (0 disables the limit).
  rateLimitSeconds: parseNonNegativeInt(process.env.RATE_LIMIT_SECONDS, 20),
  // How long a "send your feedback as the next message" prompt stays armed.
  pendingTtlSeconds: parsePositiveInt(process.env.PENDING_TTL_SECONDS, 300),
  // Feedback items per /inbox page.
  inboxPageSize: parsePositiveInt(process.env.INBOX_PAGE_SIZE, 10),
};
