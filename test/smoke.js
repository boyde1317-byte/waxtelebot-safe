const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dbPath = path.join(__dirname, 'smoke.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;
process.env.ADMIN_IDS = '42';
process.env.FEEDBACK_MAX_LEN = '2000';

const db = require('../src/db');

// --- users and submission ------------------------------------------------
db.upsertUser({ id: 7, username: 'tester', first_name: 'Test' });
const item = db.createFeedback(7, 'A test feedback message');
assert.strictEqual(item.text, 'A test feedback message');
assert.strictEqual(item.status, 'open');
assert.strictEqual(db.listOpenFeedback().length, 1);
assert.deepStrictEqual(db.feedbackCounts(), { total: 1, open: 1 });

// --- resolution ----------------------------------------------------------
assert.strictEqual(db.resolveFeedback(item.id, 42), true);
assert.deepStrictEqual(db.feedbackCounts(), { total: 1, open: 0 });
assert.strictEqual(db.resolveFeedback(item.id, 42), false);
const resolved = db.getFeedback(item.id);
assert.strictEqual(resolved.status, 'resolved');
assert.ok(resolved.resolved_at);
assert.strictEqual(resolved.resolved_by, 42);

// --- reply ---------------------------------------------------------------
const second = db.createFeedback(7, 'Second message');
assert.strictEqual(db.replyFeedback(second.id, 'Thanks, fixed.'), true);
const replied = db.getFeedback(second.id);
assert.strictEqual(replied.status, 'resolved');
assert.strictEqual(replied.reply_text, 'Thanks, fixed.');
assert.strictEqual(db.replyFeedback(second.id, 'again'), false, 'an already resolved item cannot be replied to twice');

// --- user history --------------------------------------------------------
const mine = db.listUserFeedback(7, 5);
assert.strictEqual(mine.length, 2);
assert.strictEqual(mine[0].id, second.id, 'newest first');
assert.strictEqual(db.listUserFeedback(999, 5).length, 0);

// --- pagination ----------------------------------------------------------
for (let i = 0; i < 5; i += 1) db.createFeedback(7, `pending ${i}`);
assert.strictEqual(db.listOpenFeedback(10, 0).length, 5);
assert.strictEqual(db.listOpenFeedback(2, 0).length, 2);
assert.strictEqual(db.listOpenFeedback(2, 4).length, 1);
assert.strictEqual(db.listOpenFeedback(10, 99).length, 0);

db.db.close();
fs.unlinkSync(dbPath);
if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);

// --- config parsing ------------------------------------------------------
function readConfig(env) {
  const script = 'process.stdout.write(JSON.stringify({adminIds: require("./src/config").adminIds}))';
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}
assert.deepStrictEqual(readConfig({ ADMIN_IDS: '' }).adminIds, [], 'empty ADMIN_IDS must not become [0]');
assert.deepStrictEqual(readConfig({ ADMIN_IDS: '42, 43' }).adminIds, [42, 43]);
assert.deepStrictEqual(readConfig({ ADMIN_IDS: '42,abc,0,-5' }).adminIds, [42]);

console.log('smoke test passed');
