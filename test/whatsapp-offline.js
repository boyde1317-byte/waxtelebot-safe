// Offline checks for the WhatsApp layer: no network, no real session.
process.env.DB_PATH = '/tmp/waxtele-wa-offline.db';
process.env.ADMIN_IDS = '42';
process.env.WA_ENABLED = '1';
try { require('fs').unlinkSync(process.env.DB_PATH); } catch {}

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const jid = require('../src/whatsapp/jid');

// --- phone and JID handling ----------------------------------------------
assert.strictEqual(jid.toPhoneDigits('+233 24 123 4567'), '233241234567');
assert.strictEqual(jid.toPhoneDigits('233241234567'), '233241234567');
assert.strictEqual(jid.toPhoneDigits('0241234567', '233'), '233241234567');
assert.strictEqual(jid.toPhoneDigits('0241234567'), null, 'a local number without a country code is rejected');
assert.strictEqual(jid.toPhoneDigits('12'), null);
assert.strictEqual(jid.toUserJid('+233241234567'), '233241234567@s.whatsapp.net');
assert.strictEqual(jid.toJid('120363000000000000@g.us'), '120363000000000000@g.us');
assert.strictEqual(jid.toJid('+233241234567@s.whatsapp.net'), '233241234567@s.whatsapp.net');
assert.strictEqual(jid.toJid('233241234567:12@s.whatsapp.net'), '233241234567@s.whatsapp.net', 'device suffix stripped');
assert.strictEqual(jid.toJid('nonsense'), null);
assert.strictEqual(jid.isGroupJid('120363000000000000@g.us'), true);
assert.strictEqual(jid.jidLabel('233241234567@s.whatsapp.net'), '+233241234567');

// --- session refuses to send while unpaired ------------------------------
const wa = require('../src/whatsapp/session');
assert.strictEqual(wa.status().connected, false);
assert.strictEqual(wa.hasCreds(), false);

(async () => {
  await assert.rejects(() => wa.sendText({ rawJid: '+233241234567', text: 'hi' }), /not connected/i);
  await assert.rejects(() => wa.listGroups(), /not connected/i);
  await assert.rejects(() => wa.checkNumber('233241234567'), /not connected/i);

  // --- menu wiring ------------------------------------------------------
  const handler = require('../src/handlers/whatsapp');
  const keyboard = handler.menuKeyboard().reply_markup.inline_keyboard.flat();
  assert.ok(keyboard.length >= 6, 'menu offers several actions');
  for (const button of keyboard) {
    assert.ok(button.text && button.callback_data, 'every button has text and an action');
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, `callback_data too long: ${button.callback_data}`);
  }
  assert.deepStrictEqual(
    keyboard.map(b => b.callback_data),
    ['wa:status', 'wa:pair', 'wa:send', 'wa:groups', 'wa:check', 'wa:recent']
  );
  assert.match(handler.menuText(), /Not connected/);
  assert.match(handler.menuText(), /\/pair/);

  // --- send log and settings -------------------------------------------
  const db = require('../src/db');
  db.logSend({ adminId: 42, jid: '233241234567@s.whatsapp.net', body: 'hello   there\nfriend', status: 'sent' });
  db.logSend({ adminId: 42, jid: '120363000000000000@g.us', body: 'boom', status: 'failed', error: 'not connected' });
  const sends = db.listSends(5);
  assert.strictEqual(sends.length, 2);
  assert.strictEqual(sends[0].status, 'failed');
  assert.strictEqual(sends[0].error, 'not connected');
  assert.strictEqual(sends[1].body_preview, 'hello there friend', 'preview is whitespace-collapsed');
  assert.strictEqual(db.getSetting('missing', 'fallback'), 'fallback');
  db.setSetting('wa_owner', '233241234567');
  assert.strictEqual(db.getSetting('wa_owner'), '233241234567');
  db.setSetting('wa_owner', '233241234568');
  assert.strictEqual(db.getSetting('wa_owner'), '233241234568', 'setting overwrites');
  db.db.close();

  // --- disabled by configuration ---------------------------------------
  const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'whatsapp', 'session'))}).connect({ phone: '+233241234567' })
    .then(() => { console.log('CONNECTED'); })
    .catch(e => { console.log('REFUSED: ' + e.message); });`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, WA_ENABLED: '0', DB_PATH: '/tmp/waxtele-wa-offline2.db' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.match(out, /REFUSED: WhatsApp is disabled/, 'WA_ENABLED=0 blocks connecting');

  console.log('whatsapp offline test passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
