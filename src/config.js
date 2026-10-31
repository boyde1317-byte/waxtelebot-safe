require('dotenv').config();
const path = require('path');

function parseIds(raw) {
  return String(raw || '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isSafeInteger);
}

module.exports = {
  botToken: process.env.BOT_TOKEN || '',
  adminIds: parseIds(process.env.ADMIN_IDS),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'feedback.db'),
  logLevel: process.env.LOG_LEVEL || 'info',
};
