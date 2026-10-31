const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'smoke.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;
process.env.ADMIN_IDS = '42';

const db = require('../src/db');
db.upsertUser({ id: 7, username: 'tester', first_name: 'Test' });
const item = db.createFeedback(7, 'A test feedback message');
assert.strictEqual(item.text, 'A test feedback message');
assert.strictEqual(db.listOpenFeedback().length, 1);
assert.deepStrictEqual(db.feedbackCounts(), { total: 1, open: 1 });
assert.strictEqual(db.resolveFeedback(item.id), true);
assert.deepStrictEqual(db.feedbackCounts(), { total: 1, open: 0 });
assert.strictEqual(db.resolveFeedback(item.id), false);
db.db.close();
fs.unlinkSync(dbPath);
console.log('smoke test passed');
