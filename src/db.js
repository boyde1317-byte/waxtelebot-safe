const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, id);
`);

// Additive migrations so an existing feedback.db keeps working.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('feedback', 'reply_text', 'TEXT');
ensureColumn('feedback', 'resolved_by', 'INTEGER');

const upsert = db.prepare(`INSERT INTO users (id, username, first_name, joined_at)
  VALUES (@id, @username, @first_name, @joined_at)
  ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name`);
function upsertUser(user) {
  upsert.run({ id: user.id, username: user.username || '', first_name: user.first_name || '', joined_at: new Date().toISOString() });
}

const insertFeedback = db.prepare('INSERT INTO feedback (user_id, text, created_at) VALUES (?, ?, ?)');
function createFeedback(userId, text) {
  const result = insertFeedback.run(userId, text, new Date().toISOString());
  return getFeedback(result.lastInsertRowid);
}
const getFeedbackStatement = db.prepare(`SELECT f.*, u.username, u.first_name FROM feedback f JOIN users u ON u.id=f.user_id WHERE f.id=?`);
function getFeedback(id) { return getFeedbackStatement.get(id); }
const openFeedback = db.prepare(`SELECT f.*, u.username, u.first_name FROM feedback f JOIN users u ON u.id=f.user_id WHERE f.status='open' ORDER BY f.id ASC LIMIT ? OFFSET ?`);
function listOpenFeedback(limit = 20, offset = 0) { return openFeedback.all(limit, offset); }
const userFeedback = db.prepare(`SELECT f.*, u.username, u.first_name FROM feedback f JOIN users u ON u.id=f.user_id WHERE f.user_id=? ORDER BY f.id DESC LIMIT ?`);
function listUserFeedback(userId, limit = 5) { return userFeedback.all(userId, limit); }
const resolveFeedbackStatement = db.prepare(`UPDATE feedback SET status='resolved', resolved_at=?, resolved_by=COALESCE(?, resolved_by) WHERE id=? AND status='open'`);
function resolveFeedback(id, adminId = null) {
  return resolveFeedbackStatement.run(new Date().toISOString(), adminId, id).changes > 0;
}
const replyFeedbackStatement = db.prepare(`UPDATE feedback SET status='resolved', resolved_at=?, reply_text=?, resolved_by=? WHERE id=? AND status='open'`);
function replyFeedback(id, replyText, adminId = null) {
  return replyFeedbackStatement.run(new Date().toISOString(), String(replyText), adminId, id).changes > 0;
}
const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(status='open') AS open FROM feedback`);
function feedbackCounts() { const row = counts.get(); return { total: row.total, open: row.open || 0 }; }

module.exports = { db, upsertUser, createFeedback, getFeedback, listOpenFeedback, listUserFeedback, resolveFeedback, replyFeedback, feedbackCounts };
