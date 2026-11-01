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

  // --- WhatsApp (Baileys) --------------------------------------------------
  // Set WA_ENABLED=0 to run as a pure feedback bot.
  waEnabled: String(process.env.WA_ENABLED ?? '1') !== '0',
  // Where the paired session (creds.json) is stored. Keep this out of git.
  waAuthDir: process.env.WA_AUTH_DIR || path.join(__dirname, '..', 'data', 'wa-auth'),
  // Country code applied to local numbers written without one, e.g. 233.
  waDefaultCountry: String(process.env.WA_DEFAULT_COUNTRY || '').replace(/\D/g, ''),
  // Minimum gap between two outgoing messages, in milliseconds.
  waSendMinIntervalMs: parseNonNegativeInt(process.env.WA_SEND_MIN_INTERVAL_MS, 1500),
  // Hard cap on outgoing messages per rolling hour, a brake against account bans.
  waSendHourlyCap: parsePositiveInt(process.env.WA_SEND_HOURLY_CAP, 30),
  // Groups listed by /groups.
  waGroupListLimit: parsePositiveInt(process.env.WA_GROUP_LIST_LIMIT, 20),
  // How many recent inbound media messages are kept for saving to Telegram.
  waInboxLimit: parsePositiveInt(process.env.WA_INBOX_LIMIT, 40),
  // How long to wait for an IQ result before treating it as unanswered.
  waQueryTimeoutMs: parsePositiveInt(process.env.WA_QUERY_TIMEOUT_MS, 15000),
};
