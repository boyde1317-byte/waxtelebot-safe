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
    ['wa:status', 'wa:pair', 'wa:send', 'wa:media', 'wa:chat', 'wa:groups', 'wa:check', 'wa:recent']
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

  // --- chat actions send the right app-state patches --------------------
  const session = require('../src/whatsapp/session');
  const chat = require('../src/whatsapp/chat');
  const calls = [];
  session.__setSocketForTests({
    chatModify: async (mod, jid) => { calls.push({ op: 'chatModify', mod, jid }); },
    updateBlockStatus: async (jid, action) => { calls.push({ op: 'updateBlockStatus', jid, action }); },
    groupLeave: async jid => { calls.push({ op: 'groupLeave', jid }); },
    query: async node => { calls.push({ op: 'query', node }); return { tag: 'iq', attrs: { type: 'result' } }; },
    groupInviteCode: async () => 'INVITECODE123',
    groupMetadata: async () => ({
      subject: 'Squad',
      participants: [
        { id: '233241234567@s.whatsapp.net', admin: 'superadmin' },
        { id: '233249999999@s.whatsapp.net' },
      ],
    }),
    fetchStatus: async () => [{ status: { text: 'busy' } }],
    onWhatsApp: async () => [{ exists: true, jid: '233241234567@s.whatsapp.net' }],
    profilePictureUrl: async () => 'https://example.invalid/pic.jpg',
  });

  const JID = '233241234567@s.whatsapp.net';

  await chat.setPin('+233 24 123 4567', true);
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { pin: true }, jid: JID });

  await chat.setArchive('+233241234567', true);
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { archive: true, lastMessages: [] }, jid: JID });

  await chat.markRead('+233241234567');
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { markRead: true, lastMessages: [] }, jid: JID });

  await chat.clearChat('+233241234567');
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { clear: true, lastMessages: [] }, jid: JID });

  await chat.deleteChat('+233241234567');
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { delete: true, lastMessages: [] }, jid: JID });

  await chat.setBlocked('+233241234567', true);
  assert.deepStrictEqual(calls.pop(), { op: 'updateBlockStatus', jid: JID, action: 'block' });
  await chat.setBlocked('+233241234567', false);
  assert.deepStrictEqual(calls.pop(), { op: 'updateBlockStatus', jid: JID, action: 'unblock' });

  await chat.setMute('+233241234567', 8 * 60 * 60 * 1000);
  const muteCall = calls.pop();
  assert.strictEqual(muteCall.op, 'chatModify');
  assert.ok(muteCall.mod.mute > Math.floor(Date.now() / 1000) + 8 * 60 * 60 - 10, 'mute is a future end timestamp in seconds');
  assert.ok(muteCall.mod.mute <= Math.floor(Date.now() / 1000) + 8 * 60 * 60 + 10);

  await chat.setMute('+233241234567', null);
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { mute: null }, jid: JID }, 'null unmutes');

  const info = await chat.contactInfo('+233241234567');
  assert.strictEqual(info.exists, true);
  assert.strictEqual(info.about, 'busy');
  assert.strictEqual(info.picture, 'https://example.invalid/pic.jpg');

  const invite = await chat.groupInvite('120363000000000000@g.us');
  assert.strictEqual(invite.link, 'https://chat.whatsapp.com/INVITECODE123');

  const members = await chat.groupMembers('120363000000000000@g.us', 5);
  assert.strictEqual(members.total, 2);
  assert.strictEqual(members.subject, 'Squad');
  assert.strictEqual(members.members[0].admin, true);

  await chat.leaveGroup('120363000000000000@g.us');
  assert.strictEqual(calls.pop().op, 'groupLeave');

  await chat.report('+233241234567');
  const reportCall = calls.pop();
  assert.strictEqual(reportCall.op, 'query');
  assert.strictEqual(reportCall.node.tag, 'iq');
  assert.deepStrictEqual(reportCall.node.attrs, { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' });
  assert.strictEqual(reportCall.node.content[0].tag, 'spam_list');
  assert.deepStrictEqual(reportCall.node.content[0].content[0].attrs, { jid: JID, spam_flow: 'unsolicited' });

  const reportAndBlock = await chat.report('+233241234567', { block: true });
  assert.deepStrictEqual(calls.pop(), { op: 'updateBlockStatus', jid: JID, action: 'block' });
  assert.deepStrictEqual(reportAndBlock, { jid: JID, blocked: true });
  assert.strictEqual(calls.pop().op, 'query', 'report is sent before the block');

  await chat.report('+233241234567').then(
    () => { throw new Error('report without a socket should be rejected'); },
    () => {}
  ).catch(() => {});

  await chat.setPin('not a number', true).then(
    () => { throw new Error('a bad target should be rejected'); },
    error => assert.match(error.message, /valid number or group/i)
  );
  session.__setSocketForTests(null);

  // --- inbound media index ---------------------------------------------
  const inbox = require('../src/whatsapp/inbox');
  const mediaMessage = {
    key: { id: 'MSG1', remoteJid: JID, fromMe: false },
    messageTimestamp: 1793000000,
    pushName: 'Ama',
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'look at this' } },
  };
  inbox.record(mediaMessage);
  inbox.record({ key: { id: 'TXT1', remoteJid: JID }, message: { conversation: 'hello' } });
  inbox.record({ key: { id: 'EPH1', remoteJid: JID }, messageTimestamp: 1793000100, message: { ephemeralMessage: { message: { imageMessage: { mimetype: 'image/png' } } } } });

  const listed = inbox.list({ limit: 5 });
  assert.strictEqual(listed.length, 3, 'text is indexed alongside media');
  assert.strictEqual(listed.filter(e => e.kind === 'media').length, 2);
  assert.strictEqual(listed.filter(e => e.kind === 'text').length, 1);
  assert.strictEqual(listed[0].id, 'EPH1', 'newest first, and wrapped media is unwrapped');
  assert.strictEqual(listed[0].mime, 'image/png');
  const imageEntry = listed.find(e => e.id === 'MSG1');
  assert.strictEqual(imageEntry.caption, 'look at this');
  assert.match(inbox.label(imageEntry), /image · Ama/);
  assert.strictEqual(listed[1].id, 'TXT1');
  assert.match(inbox.label(listed[1]), /text · /);
  const lastText = inbox.lastText(JID);
  assert.strictEqual(lastText.text, 'hello');
  assert.strictEqual(inbox.lastText('120363000000000000@g.us'), null);
  assert.strictEqual(inbox.list({ jid: JID, kind: 'media' }).length, 2, 'media filter excludes text');
  assert.strictEqual(inbox.list({ jid: '120363000000000000@g.us' }).length, 0);
  assert.strictEqual(inbox.list({ jid: JID }).length, 3);
  await assert.rejects(() => inbox.download('MSG1'), /not connected/i, 'downloading needs a live socket');

  // --- expanded menu stays within Telegram limits ----------------------
  const menuButtons = handler.menuKeyboard().reply_markup.inline_keyboard.flat();
  const chatButtons = handler.chatKeyboard(JID).reply_markup.inline_keyboard.flat();
  const groupButtons = handler.groupKeyboard('120363000000000000@g.us').reply_markup.inline_keyboard.flat();
  assert.ok(menuButtons.length >= 8, 'menu grew with media and chat actions');
  assert.ok(chatButtons.length >= 17, 'chat actions cover mute, pin, archive, read, clear, delete, block, report, copy, info');
  assert.ok(chatButtons.some(b => b.callback_data === 'wac:report'));
  assert.ok(chatButtons.some(b => b.callback_data === 'wac:copy'));
  assert.ok(chatButtons.some(b => b.callback_data === 'wac:block'));
  assert.strictEqual(groupButtons.length, 4);
  for (const button of [...menuButtons, ...chatButtons, ...groupButtons]) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, `callback_data too long: ${button.callback_data}`);
  }
  assert.strictEqual(typeof handler.MUTE_OPTIONS.mute8.ms, 'number');
  assert.strictEqual(handler.MUTE_OPTIONS.unmute.ms, null);

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
