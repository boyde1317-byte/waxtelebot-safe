// Offline checks for the WhatsApp layer: no network, no real session.
process.env.DB_PATH = '/tmp/waxtele-wa-offline.db';
process.env.ADMIN_IDS = '42';
process.env.WA_ENABLED = '1';
process.env.WA_DEFAULT_COUNTRY = '233';
process.env.WA_MAX_ACCOUNTS = '2';
process.env.WA_SEND_HOURLY_CAP = '2';
process.env.WA_SEND_MIN_INTERVAL_MS = '0';
process.env.WA_ACCOUNTS_DIR = '/tmp/waxtele-accounts-test';
process.env.WA_AUTH_DIR = '/tmp/waxtele-legacy-none';
for (const file of ['/tmp/waxtele-wa-offline.db', '/tmp/waxtele-wa-offline.db-wal', '/tmp/waxtele-wa-offline.db-shm']) {
  try { require('fs').unlinkSync(file); } catch {}
}
try { require('fs').rmSync(process.env.WA_ACCOUNTS_DIR, { recursive: true, force: true }); } catch {}

const assert = require('assert');
const { proto } = require('baileys');
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

const JID = '233241234567@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

(async () => {
  // --- an unpaired session refuses to act -------------------------------
  const { createSession } = require('../src/whatsapp/session');
  const lonely = createSession({ id: 99, label: 'Lonely', authDir: '/tmp/waxtele-none-99' });
  assert.strictEqual(lonely.status().connected, false);
  assert.strictEqual(lonely.hasCreds(), false);
  await assert.rejects(() => lonely.sendText({ rawJid: '+233241234567', text: 'hi' }), /not connected/i);
  await assert.rejects(() => lonely.listGroups(), /not connected/i);
  await assert.rejects(() => lonely.checkNumber('233241234567'), /not connected/i);

  // --- accounts are separate sessions with separate folders -------------
  const accounts = require('../src/whatsapp/accounts');
  const db = require('../src/db');
  accounts.init();
  assert.strictEqual(accounts.list().length, 0, 'a fresh install starts with no accounts');

  const first = accounts.create();
  const second = accounts.create('Work');
  assert.strictEqual(accounts.list().length, 2);
  assert.notStrictEqual(first.status().authDir, second.status().authDir, 'each account gets its own auth folder');
  assert.ok(first.status().authDir.includes('account-'), 'folders live under the accounts directory');
  assert.match(first.snapshot.label, /Account 1/);
  assert.strictEqual(second.snapshot.label, 'Work');
  assert.throws(() => accounts.create(), /limit/i, 'the roster is capped');
  assert.strictEqual(accounts.get(first.id).id, first.id);
  assert.strictEqual(accounts.get(999), null);

  // active account: default to the first, switch on request
  assert.strictEqual(accounts.active(42).id, first.id);
  assert.strictEqual(accounts.setActive(42, second.id), true);
  assert.strictEqual(accounts.active(42).id, second.id);
  assert.strictEqual(accounts.setActive(42, 999), false);
  assert.strictEqual(accounts.active(42).id, second.id, 'a bad switch leaves the choice alone');
  assert.match(accounts.summaryLine(42), /Work/);
  accounts.setActive(42, first.id);

  // --- one number is one session ---------------------------------------
  const fs = require('fs');
  const pathModule = require('path');
  const credsDir = first.status().authDir;
  fs.mkdirSync(credsDir, { recursive: true });
  fs.writeFileSync(pathModule.join(credsDir, 'creds.json'), '{}');
  db.updateAccount(first.id, { phone: '233241234567' });
  assert.strictEqual(accounts.phoneClash('233241234567').id, first.id, 'a paired number is recognised');
  assert.strictEqual(accounts.phoneClash('233241234567', first.id), null, 'an account is not a clash with itself');
  assert.strictEqual(accounts.phoneClash('233249999999'), null);
  assert.strictEqual(accounts.phoneClash(null), null);

  // --- menu wiring ------------------------------------------------------
  const handler = require('../src/handlers/whatsapp');
  const menu = handler.menuKeyboard(42).reply_markup.inline_keyboard.flat();
  const menuText = handler.menuText(42);
  assert.match(menuText, /Accounts: 2 linked/);
  assert.ok(menu.some(b => b.callback_data === `wa:acct:${first.id}`), 'each account has a switch button');
  assert.ok(menu.some(b => b.callback_data === `wa:acct:${second.id}`));
  assert.ok(menu.some(b => b.callback_data === 'wa:add'));
  for (const button of menu) {
    assert.ok(button.text && button.callback_data, 'every button has text and an action');
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, `callback_data too long: ${button.callback_data}`);
  }

  const chatButtons = handler.chatKeyboard().reply_markup.inline_keyboard.flat();
  const groupButtons = handler.groupKeyboard().reply_markup.inline_keyboard.flat();
  assert.ok(chatButtons.length >= 17, 'chat actions cover mute, pin, archive, read, clear, delete, block, report, copy, info');
  assert.ok(chatButtons.some(b => b.callback_data === 'wac:report'));
  assert.ok(chatButtons.some(b => b.callback_data === 'wac:copy'));
  assert.ok(chatButtons.some(b => b.callback_data === 'wac:block'));
  assert.strictEqual(groupButtons.length, 4);
  for (const button of [...chatButtons, ...groupButtons]) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, `callback_data too long: ${button.callback_data}`);
  }
  assert.strictEqual(typeof handler.MUTE_OPTIONS.mute8.ms, 'number');
  assert.strictEqual(handler.MUTE_OPTIONS.unmute.ms, null);

  // --- send log and settings -------------------------------------------
  db.logSend({ adminId: 42, accountId: first.id, jid: JID, body: 'hello   there\nfriend', status: 'sent' });
  db.logSend({ adminId: 42, accountId: second.id, jid: GROUP, body: 'boom', status: 'failed', error: 'not connected' });
  const sends = db.listSends(5);
  assert.strictEqual(sends.length, 2);
  assert.strictEqual(sends[0].status, 'failed');
  assert.strictEqual(sends[0].error, 'not connected');
  assert.strictEqual(sends[0].account_id, second.id, 'the send log records which account sent it');
  assert.strictEqual(sends[1].body_preview, 'hello there friend', 'preview is whitespace-collapsed');
  assert.strictEqual(db.getSetting('missing', 'fallback'), 'fallback');
  db.setSetting('wa_owner', '233241234567');
  assert.strictEqual(db.getSetting('wa_owner'), '233241234567');
  db.setSetting('wa_owner', '233241234568');
  assert.strictEqual(db.getSetting('wa_owner'), '233241234568', 'setting overwrites');

  // --- chat actions send the right app-state patches --------------------
  const chat = require('../src/whatsapp/chat');
  const calls = [];
  const fakeSocket = {
    chatModify: async (mod, target) => { calls.push({ op: 'chatModify', mod, jid: target }); },
    updateBlockStatus: async (target, action) => { calls.push({ op: 'updateBlockStatus', jid: target, action }); },
    groupLeave: async target => { calls.push({ op: 'groupLeave', jid: target }); },
    query: async (node, timeoutMs) => { calls.push({ op: 'query', node, timeoutMs }); return fakeSocket.queryResult; },
    queryResult: undefined,
    groupInviteCode: async () => 'INVITECODE123',
    groupMetadata: async () => ({
      subject: 'Squad',
      participants: [
        { id: JID, admin: 'superadmin' },
        { id: '233249999999@s.whatsapp.net' },
      ],
    }),
    fetchStatus: async () => [{ status: { text: 'busy' } }],
    onWhatsApp: async () => [{ exists: true, jid: JID }],
    profilePictureUrl: async () => 'https://example.invalid/pic.jpg',
    sendMessage: async (target, payload) => ({ key: { id: 'SENT1' }, target, payload }),
  };
  first.__setSocketForTests(fakeSocket);

  await chat.setPin(first, '+233 24 123 4567', true);
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { pin: true }, jid: JID });

  await chat.setArchive(first, '+233241234567', true);
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { archive: true, lastMessages: [] }, jid: JID });

  await chat.markRead(first, '+233241234567');
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { markRead: true, lastMessages: [] }, jid: JID });

  await chat.clearChat(first, '+233241234567');
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { clear: true, lastMessages: [] }, jid: JID });

  await chat.deleteChat(first, '+233241234567');
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { delete: true, lastMessages: [] }, jid: JID });

  await chat.setBlocked(first, '+233241234567', true);
  assert.deepStrictEqual(calls.pop(), { op: 'updateBlockStatus', jid: JID, action: 'block' });
  await chat.setBlocked(first, '+233241234567', false);
  assert.deepStrictEqual(calls.pop(), { op: 'updateBlockStatus', jid: JID, action: 'unblock' });

  await chat.setMute(first, '+233241234567', 8 * 60 * 60 * 1000);
  const muteCall = calls.pop();
  assert.strictEqual(muteCall.op, 'chatModify');
  assert.ok(muteCall.mod.mute > Math.floor(Date.now() / 1000) + 8 * 60 * 60 - 10, 'mute is a future end timestamp in seconds');
  assert.ok(muteCall.mod.mute <= Math.floor(Date.now() / 1000) + 8 * 60 * 60 + 10);

  await chat.setMute(first, '+233241234567', null);
  assert.deepStrictEqual(calls.pop(), { op: 'chatModify', mod: { mute: null }, jid: JID }, 'null unmutes');

  const info = await chat.contactInfo(first, '+233241234567');
  assert.strictEqual(info.exists, true);
  assert.strictEqual(info.about, 'busy');
  assert.strictEqual(info.picture, 'https://example.invalid/pic.jpg');

  const invite = await chat.groupInvite(first, GROUP);
  assert.strictEqual(invite.link, 'https://chat.whatsapp.com/INVITECODE123');

  const members = await chat.groupMembers(first, GROUP, 5);
  assert.strictEqual(members.total, 2);
  assert.strictEqual(members.subject, 'Squad');
  assert.strictEqual(members.members[0].admin, true);

  await chat.leaveGroup(first, GROUP);
  assert.strictEqual(calls.pop().op, 'groupLeave');

  // a second account is never touched by the first one's actions
  const otherCalls = [];
  second.__setSocketForTests({
    chatModify: async (mod, target) => { otherCalls.push({ mod, target }); },
  });
  const before = calls.length;
  await chat.setPin(second, '+233241234567', true);
  assert.strictEqual(calls.length, before, 'the first account saw nothing');
  assert.deepStrictEqual(otherCalls, [{ mod: { pin: true }, target: JID }]);

  // --- report: exact spam IQ from the whatsapp-rust wire format ----------
  const entry = {
    id: 'MSG1',
    jid: JID,
    at: 1793000000000,
    fromJid: JID,
    isGroup: false,
    mediaType: null,
    inner: { conversation: 'pay me 200 cedis' },
  };

  fakeSocket.queryResult = { tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'report_id', content: 'REPORT_9' }] };
  const reported = await chat.reportMessage(first, entry);
  const reportCall = calls.pop();
  assert.strictEqual(reportCall.op, 'query');
  assert.strictEqual(reportCall.timeoutMs, 15000, 'a report never waits the 60s default');
  assert.deepStrictEqual(reportCall.node.attrs, { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' });
  const spamList = reportCall.node.content[0];
  assert.strictEqual(spamList.tag, 'spam_list');
  assert.deepStrictEqual(spamList.attrs, { spam_flow: 'MessageMenu' }, 'spam_flow lives on spam_list');
  const messageNode = spamList.content[0];
  assert.strictEqual(messageNode.tag, 'message');
  assert.deepStrictEqual(messageNode.attrs, { id: 'MSG1', t: '1793000000', from: JID });
  const rawNode = messageNode.content[0];
  assert.strictEqual(rawNode.tag, 'raw');
  assert.deepStrictEqual(rawNode.attrs, { v: '3' });
  assert.ok(Buffer.isBuffer(rawNode.content) && rawNode.content.length > 0, 'the message bytes are attached');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(proto.Message.decode(rawNode.content))), { conversation: 'pay me 200 cedis' });
  assert.strictEqual(reported.status, 'confirmed');
  assert.strictEqual(reported.reportId, 'REPORT_9');
  assert.strictEqual(reported.blocked, false);

  const groupEntry = {
    id: 'G1', jid: GROUP, at: 1793000500000, isGroup: true,
    fromJid: '233249999999@s.whatsapp.net', participant: '233249999999@s.whatsapp.net',
    mediaType: 'image', inner: { imageMessage: { mimetype: 'image/jpeg' } },
  };
  await chat.reportMessage(first, groupEntry, { subject: 'Squad', block: true });
  const blockCall = calls.pop();
  assert.deepStrictEqual(blockCall, { op: 'updateBlockStatus', jid: GROUP, action: 'block' });
  const groupCall = calls.pop();
  assert.deepStrictEqual(groupCall.node.content[0].attrs, { spam_flow: 'GroupInfoReport', jid: GROUP, subject: 'Squad' });
  assert.deepStrictEqual(groupCall.node.content[0].content[0].attrs, {
    id: 'G1', t: '1793000500', from: '233249999999@s.whatsapp.net', participant: '233249999999@s.whatsapp.net',
  });
  assert.deepStrictEqual(groupCall.node.content[0].content[0].content[0].attrs, { v: '3', mediatype: 'image' });

  fakeSocket.queryResult = undefined;
  const unanswered = await chat.reportMessage(first, entry);
  assert.strictEqual(unanswered.status, 'unanswered');
  assert.strictEqual(unanswered.reportId, null);

  fakeSocket.queryResult = { tag: 'iq', attrs: { type: 'result' }, content: [] };
  const unconfirmed = await chat.reportMessage(first, entry);
  assert.strictEqual(unconfirmed.status, 'unconfirmed');

  await chat.reportMessage(first, null).then(
    () => { throw new Error('reporting nothing should be rejected'); },
    error => assert.match(error.message, /no message to report/i)
  );

  await chat.setPin(first, 'not a number', true).then(
    () => { throw new Error('a bad target should be rejected'); },
    error => assert.match(error.message, /valid number or group/i)
  );

  // --- per-account send budget -----------------------------------------
  const sent = await first.sendText({ rawJid: '+233241234567', text: 'one', adminId: 42 });
  assert.strictEqual(sent.jid, JID);
  await first.sendText({ rawJid: '+233241234567', text: 'two', adminId: 42 });
  await assert.rejects(() => first.sendText({ rawJid: '+233241234567', text: 'three', adminId: 42 }), /cap reached/i);
  assert.match(db.listSends(1)[0].body_preview, /three|two/, 'failed sends are logged too');
  second.__setSocketForTests({ sendMessage: async () => ({ key: { id: 'X' } }) });
  await second.sendText({ rawJid: '+233241234567', text: 'other account', adminId: 42 });
  assert.strictEqual(db.listSends(1)[0].account_id, second.id, 'each account has its own budget and its own log row');

  // --- inbound media index is scoped per account ------------------------
  const inbox = require('../src/whatsapp/inbox');
  inbox.record({
    key: { id: 'MEDIA1', remoteJid: JID, fromMe: false },
    messageTimestamp: 1793000000,
    pushName: 'Ama',
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'look at this' } },
  }, first.status());
  inbox.record({ key: { id: 'TXT1', remoteJid: JID }, message: { conversation: 'hello' } }, first.status());
  inbox.record({
    key: { id: 'EPH1', remoteJid: JID },
    messageTimestamp: 1793000100,
    message: { ephemeralMessage: { message: { imageMessage: { mimetype: 'image/png' } } } },
  }, second.status());

  assert.strictEqual(inbox.list({ limit: 5 }).length, 3);
  assert.strictEqual(inbox.list({ accountId: first.id, limit: 5 }).length, 2, 'accounts do not see each other');
  assert.strictEqual(inbox.list({ accountId: second.id, limit: 5 }).length, 1);
  const mine = inbox.list({ accountId: first.id, limit: 5 });
  const imageEntry = mine.find(item => item.id === 'MEDIA1');
  assert.strictEqual(imageEntry.caption, 'look at this');
  assert.strictEqual(imageEntry.accountLabel, first.snapshot.label);
  assert.match(inbox.label(imageEntry), /image · Ama/);
  assert.strictEqual(inbox.lastText(JID, first.id).text, 'hello');
  assert.strictEqual(inbox.lastText(JID, second.id), null);
  assert.strictEqual(inbox.list({ accountId: first.id, jid: JID, kind: 'media' }).length, 1, 'media filter excludes text');
  assert.strictEqual(inbox.get('EPH1').accountId, second.id);
  assert.strictEqual(inbox.get('nope'), null);

  // wrapped media is unwrapped and carries the sender for reporting
  const wrapped = inbox.get('EPH1');
  assert.strictEqual(wrapped.mime, 'image/png');
  first.__setSocketForTests(null);
  await assert.rejects(() => inbox.download('MEDIA1'), /not connected/i, 'downloading needs that account to be live');
  first.__setSocketForTests(fakeSocket);

  // --- a real indexed message produces a complete report ----------------
  fakeSocket.queryResult = { tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'report_id', content: 'R2' }] };
  const indexed = inbox.list({ accountId: first.id, jid: JID, kind: 'media', limit: 1 })[0];
  const fromIndex = await chat.reportMessage(first, indexed);
  const indexedCall = calls.pop();
  const indexedMessage = indexedCall.node.content[0].content[0];
  assert.strictEqual(indexedMessage.attrs.id, 'MEDIA1');
  assert.strictEqual(indexedMessage.attrs.from, JID, 'the sender comes from the index');
  assert.ok(indexedMessage.content[0], 'the indexed protobuf is attached');
  assert.deepStrictEqual(indexedMessage.content[0].attrs, { v: '3', mediatype: 'image' });
  assert.strictEqual(fromIndex.status, 'confirmed');

  // --- removing one account leaves the other alone ----------------------
  await accounts.remove(second.id);
  await assert.rejects(() => inbox.download('EPH1'), /no longer linked/i, 'media from a removed account cannot be fetched');
  assert.deepStrictEqual(accounts.list().map(row => row.id), [first.id]);
  assert.strictEqual(accounts.get(second.id), null);
  assert.strictEqual(accounts.active(42).id, first.id, 'the active account falls back to a live one');

  db.db.close();
  await accounts.stopAll();
  console.log('whatsapp offline test passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
