// Telegram-side controls: several WhatsApp accounts, one active at a time.
const { Input } = require('telegraf');
const config = require('../config');
const db = require('../db');
const log = require('../utils/logger');
const accounts = require('../whatsapp/accounts');
const chat = require('../whatsapp/chat');
const inbox = require('../whatsapp/inbox');
const { toJid, toPhoneDigits, jidLabel } = require('../whatsapp/jid');

const pendingInput = new Map(); // adminId -> { step, jid, accountId }
const activeChat = new Map(); // `${adminId}:${accountId}` -> jid the chat buttons act on
const pendingReports = new Map(); // token -> { entryId, jid, accountId, adminId, createdAt, consumed }

function chatKey(adminId, accountId) {
  return `${adminId}:${accountId}`;
}

function getActiveChat(adminId, accountId) {
  if (!accountId) return null;
  return activeChat.get(chatKey(adminId, accountId)) || null;
}

function setActiveChat(adminId, accountId, jid) {
  if (!accountId) return;
  activeChat.set(chatKey(adminId, accountId), jid);
}

function clearActiveChat(adminId, accountId = null) {
  if (accountId !== null) {
    activeChat.delete(chatKey(adminId, accountId));
  } else {
    for (const key of Array.from(activeChat.keys())) {
      if (key.startsWith(`${adminId}:`)) activeChat.delete(key);
    }
  }
}

function createReportToken(adminId, accountId, entry) {
  const now = Date.now();
  for (const [key, val] of Array.from(pendingReports.entries())) {
    if (val.consumed || now - val.createdAt > 30 * 60 * 1000) {
      pendingReports.delete(key);
    }
  }
  const token = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  pendingReports.set(token, {
    entryId: entry.id,
    jid: entry.jid,
    accountId,
    adminId,
    createdAt: now,
    consumed: false,
  });
  return token;
}

const MUTE_OPTIONS = {
  mute8: { label: 'Muted for 8 hours', ms: 8 * 60 * 60 * 1000 },
  mute1w: { label: 'Muted for a week', ms: 7 * 24 * 60 * 60 * 1000 },
  muteAlways: { label: 'Muted until you unmute it', ms: 100 * 365 * 24 * 60 * 60 * 1000 },
  unmute: { label: 'Unmuted', ms: null },
};

function isAdmin(ctx) {
  return config.adminIds.includes(ctx.from?.id);
}

function staleRows() {
  return accounts.list().filter(row => !row.status.connected && !row.status.hasCreds);
}

// Owner/admin only: these sessions hold no credentials, so wiping only deletes
// the local records. It cannot unlink a device on the phone, because there is
// nothing left to log out with.
function staleSummary(callbackData) {
  const rows = staleRows();
  const lines = rows.map(row => `- ${row.label}${row.phone ? ` +${row.phone}` : ''} (${row.status.state})`);
  return {
    text: [
      `Failed or stale sessions (${rows.length} of ${accounts.list().length}):`,
      ...lines,
      '',
      'Wiping logs them out and deletes them. Linked devices that still work are untouched.',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: `Wipe ${rows.length}`, callback_data: callbackData },
          { text: 'Cancel', callback_data: 'wa:menu' },
        ],
      ],
    },
  };
}

function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;
  ctx.reply('This command is restricted to administrators.');
  return false;
}

function accountTag(row) {
  const phone = row.status?.number || row.phone;
  return `${row.label}${phone ? ` +${phone}` : ''}`;
}

function statusLine(session) {
  // A row can have no live session yet (boot ordering), so never deref blindly.
  const s = session ? session.status() : { state: 'idle', connected: false, hasCreds: false };
  const bits = [s.connected ? 'connected' : s.state === 'pairing' ? 'waiting for the code' : `not connected (${s.state})`];
  if (s.since) bits.push(`since ${s.since.slice(0, 16).replace('T', ' ')}Z`);
  if (!s.connected && s.lastError) bits.push(s.lastError);
  if (!s.hasCreds) bits.push('not paired');
  return bits.join(' · ');
}

const ACCOUNTS_PER_PAGE = 6;

function pageCount(total) {
  return Math.max(1, Math.ceil(total / ACCOUNTS_PER_PAGE));
}

function accountButtons(adminId, page = 0) {
  const rows = accounts.list();
  const current = accounts.active(adminId);
  const pages = pageCount(rows.length);
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const visible = rows.slice(safePage * ACCOUNTS_PER_PAGE, (safePage + 1) * ACCOUNTS_PER_PAGE);
  const buttons = visible.map(row => {
    const mark = row.status.connected ? '✓' : '·';
    const me = current && current.id === row.id ? '▸' : '';
    return {
      text: `${me}${row.label}${row.phone ? ` +${row.phone}` : ''} ${mark}`.trim(),
      callback_data: `wa:acct:${row.id}`,
    };
  });
  const lines = [];
  for (let i = 0; i < buttons.length; i += 2) lines.push(buttons.slice(i, i + 2));
  if (pages > 1) {
    lines.push([
      { text: '‹', callback_data: `wa:acctpage:${(safePage + pages - 1) % pages}` },
      { text: `${safePage + 1}/${pages}`, callback_data: 'wa:noop' },
      { text: '›', callback_data: `wa:acctpage:${(safePage + 1) % pages}` },
    ]);
  }
  lines.push([{ text: '+ Add account', callback_data: 'wa:add' }]);
  return lines;
}

function menuText(adminId, page = 0) {
  const rows = accounts.list();
  const current = accounts.active(adminId);
  const head = ['WhatsApp'];
  if (!rows.length) {
    head.push('No accounts linked yet.');
  } else {
    const connected = rows.filter(row => row.status.connected).length;
    const pages = pageCount(rows.length);
    const pageNote = pages > 1 ? ` · page ${Math.min(page, pages - 1) + 1}/${pages}` : '';
    head.push(`Active: ${current ? accountTag({ label: current.snapshot.label, status: { number: current.snapshot.number } }) : 'none'}`);
    head.push(`Accounts: ${rows.length}/${config.waMaxAccounts} linked, ${connected} connected${pageNote}`);
  }
  head.push('', 'Commands: /pair <number> · /send <target> <text> · /chat <target> · /groups · /media · /accounts · /unpair · /cancelwa');
  return head.join('\n');
}

function menuKeyboard(adminId, page = 0) {
  const rows = accounts.list();
  if (!rows.length) {
    return { reply_markup: { inline_keyboard: [[{ text: '+ Add account', callback_data: 'wa:add' }]] } };
  }
  return {
    reply_markup: {
      inline_keyboard: [
        ...accountButtons(adminId, page),
        [
          { text: 'Send a message', callback_data: 'wa:send' },
          { text: 'Save media', callback_data: 'wa:media' },
        ],
        [
          { text: 'Chat actions', callback_data: 'wa:chat' },
          { text: 'Groups', callback_data: 'wa:groups' },
        ],
        [
          { text: 'Check a number', callback_data: 'wa:check' },
          { text: 'Recent sends', callback_data: 'wa:recent' },
        ],
        [
          { text: 'Account status', callback_data: 'wa:status' },
          { text: 'Unpair this account', callback_data: 'wa:unpairask' },
        ],
        [
          { text: 'Wipe failed/stale sessions', callback_data: 'wa:wipestaleask' },
        ],
      ],
    },
  };
}

function chatKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Mute 8h', callback_data: 'wac:mute8' },
          { text: 'Mute 1w', callback_data: 'wac:mute1w' },
          { text: 'Mute always', callback_data: 'wac:muteAlways' },
        ],
        [
          { text: 'Unmute', callback_data: 'wac:unmute' },
          { text: 'Pin', callback_data: 'wac:pin' },
          { text: 'Unpin', callback_data: 'wac:unpin' },
        ],
        [
          { text: 'Archive', callback_data: 'wac:archive' },
          { text: 'Unarchive', callback_data: 'wac:unarchive' },
          { text: 'Mark read', callback_data: 'wac:read' },
        ],
        [
          { text: 'Clear messages', callback_data: 'wac:clear' },
          { text: 'Delete chat', callback_data: 'wac:delete' },
        ],
        [
          { text: 'Block', callback_data: 'wac:block' },
          { text: 'Unblock', callback_data: 'wac:unblock' },
          { text: 'Report', callback_data: 'wac:report' },
        ],
        [
          { text: 'Contact info', callback_data: 'wac:info' },
          { text: 'Copy last message', callback_data: 'wac:copy' },
        ],
        [
          { text: 'Send a message', callback_data: 'wac:send' },
          { text: 'Media in this chat', callback_data: 'wac:media' },
        ],
      ],
    },
  };
}

function groupKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Send a message', callback_data: 'wag:send' },
          { text: 'Invite link', callback_data: 'wag:link' },
        ],
        [
          { text: 'Members', callback_data: 'wag:members' },
          { text: 'Leave group', callback_data: 'wag:leave' },
        ],
      ],
    },
  };
}

function stage(adminId, step, extra = {}) {
  pendingInput.set(adminId, { step, ...extra });
  return pendingInput.get(adminId);
}

function clearStage(adminId) {
  pendingInput.delete(adminId);
}

// Every action resolves the account the admin is currently driving.
function sessionFor(ctx) {
  const session = accounts.active(ctx.from.id);
  if (!session) {
    ctx.reply('No WhatsApp account linked yet. Add one with /pair <number> or the Add account button.');
    return null;
  }
  return session;
}

function unpairedAccount() {
  const row = accounts.list().find(entry => !entry.status.hasCreds);
  return row ? accounts.get(row.id) : null;
}

async function beginPairing(ctx, phone) {
  const digits = toPhoneDigits(phone, config.waDefaultCountry);
  if (!digits) {
    return ctx.reply('That does not look like a phone number. Include the country code, e.g. +233241234567.');
  }
  const clash = accounts.phoneClash(digits);
  if (clash) {
    return ctx.reply(
      [
        `+${digits} is already paired as ${clash.label}.`,
        '',
        'One number is one session. Pairing it again would add a second linked device to the same WhatsApp account, not a new account.',
        `Switch to it with /account ${clash.id}, or unpair it first if you want to start over.`,
      ].join('\n')
    );
  }

  let session;
  try {
    session = unpairedAccount() || accounts.create();
  } catch (error) {
    return ctx.reply(`Could not add an account: ${error.message}`);
  }
  accounts.setActive(ctx.from.id, session.id);
  const label = session.snapshot.label;
  await ctx.reply(`Pairing ${label} with ${phone}…`);
  try {
    const result = await session.connect({ phone });
    if (!result?.code) {
      return ctx.reply(`${label} is already paired as +${result?.number || 'unknown'}. It is the active account now.`);
    }
    return ctx.reply(
      [
        `Pairing code for ${label}: ${result.code}`,
        '',
        'On the phone with that WhatsApp account:',
        'Settings → Linked devices → Link a device → Link with phone number instead.',
        'Enter the code above. It expires in about a minute.',
        '',
        'Add another account any time with /pair <number>; up to ' + config.waMaxAccounts + ' fit.',
      ].join('\n')
    );
  } catch (error) {
    log.warn('Pairing failed: %s', error.message);
    return ctx.reply(`Could not start pairing: ${error.message}`);
  }
}

async function doSend(ctx, session, rawJid, text) {
  try {
    const result = await session.sendText({ rawJid, text, adminId: ctx.from.id });
    return ctx.reply(`Sent to ${jidLabel(result.jid)} from ${session.snapshot.label}.`);
  } catch (error) {
    log.warn('Send failed: %s', error.message);
    return ctx.reply(`Could not send: ${error.message}`);
  }
}

async function replyGroups(ctx, session) {
  try {
    const groups = await session.listGroups();
    if (!groups.length) return ctx.reply(`This account (${session.snapshot.label}) is not in any groups.`);
    const lines = groups.map((g, i) => `${i + 1}. ${g.subject} · ${g.participants} members\n   ${g.jid}`);
    const rows = groups.slice(0, 8).map(g => [{ text: g.subject.slice(0, 40), callback_data: `wa:g:${g.jid}` }]);
    return ctx.reply(`${session.snapshot.label} groups:\n${lines.join('\n')}`, {
      reply_markup: rows.length ? { inline_keyboard: rows } : undefined,
    });
  } catch (error) {
    return ctx.reply(`Could not load groups: ${error.message}`);
  }
}

async function replyMedia(ctx, session, jid = null) {
  const items = inbox.list({ accountId: session.id, jid, kind: 'media', limit: 8 });
  if (!items.length) {
    return ctx.reply(`Nothing recent on ${session.snapshot.label}. Media shows up here once it arrives while the bot is connected.`);
  }
  const rows = items.map(item => [{
    text: `${inbox.label(item)}`.slice(0, 60),
    callback_data: `wa:m:${item.id}`,
  }]);
  return ctx.reply(`Recent media on ${session.snapshot.label}. Tap one to bring it here.`, {
    reply_markup: { inline_keyboard: rows },
  });
}

function fileNameFor(entry) {
  const ext = (entry.mime || '').split('/')[1]?.split(';')[0] || 'bin';
  return entry.fileName || `whatsapp-${entry.id.slice(-6)}.${ext}`;
}

async function sendMediaToTelegram(ctx, id) {
  try {
    const media = await inbox.download(id);
    const caption = [`${jidLabel(media.jid)} · ${inbox.label(media)}`, media.caption].filter(Boolean).join('\n');
    const input = Input.fromBuffer(media.buffer, fileNameFor(media));
    if (media.mime.startsWith('image/')) return await ctx.replyWithPhoto(input, { caption });
    if (media.mime.startsWith('video/')) return await ctx.replyWithVideo(input, { caption });
    return await ctx.replyWithDocument(input, { caption });
  } catch (error) {
    log.warn('Media download failed: %s', error.message);
    return ctx.reply(`Could not fetch that media: ${error.message}`);
  }
}

async function runChatAction(ctx, session, jid, action) {
  const country = config.waDefaultCountry;
  const mute = MUTE_OPTIONS[action];

  try {
    if (mute) {
      await chat.setMute(session, jid, mute.ms, country);
      return ctx.reply(`${jidLabel(jid)} on ${session.snapshot.label}: ${mute.label}.`);
    }
    switch (action) {
      case 'pin':
        await chat.setPin(session, jid, true, country);
        return ctx.reply(`${jidLabel(jid)} pinned.`);
      case 'unpin':
        await chat.setPin(session, jid, false, country);
        return ctx.reply(`${jidLabel(jid)} unpinned.`);
      case 'archive':
        await chat.setArchive(session, jid, true, country);
        return ctx.reply(`${jidLabel(jid)} archived.`);
      case 'unarchive':
        await chat.setArchive(session, jid, false, country);
        return ctx.reply(`${jidLabel(jid)} unarchived.`);
      case 'read':
        await chat.markRead(session, jid, country);
        return ctx.reply(`${jidLabel(jid)} marked as read.`);
      case 'clear':
        await chat.clearChat(session, jid, country);
        return ctx.reply(`Messages cleared from ${jidLabel(jid)}.`);
      case 'delete':
        await chat.deleteChat(session, jid, country);
        clearActiveChat(ctx.from.id, session.id);
        return ctx.reply(`${jidLabel(jid)} deleted from the chat list.`);
      case 'block':
        await chat.setBlocked(session, jid, true, country);
        return ctx.reply(`${jidLabel(jid)} blocked.`);
      case 'unblock':
        await chat.setBlocked(session, jid, false, country);
        return ctx.reply(`${jidLabel(jid)} unblocked.`);
      case 'report': {
        const [entry] = inbox.list({ accountId: session.id, jid, limit: 1 });
        if (!entry) {
          return ctx.reply(
            `Nothing from ${jidLabel(jid)} to report on ${session.snapshot.label}.\n\nWhatsApp takes reports against a specific message, and I only hold messages that arrive while the bot is connected. Wait for one to come in, then try again.`
          );
        }
        const token = createReportToken(ctx.from.id, session.id, entry);
        const preview = (entry.text || '(media without a caption)').slice(0, 160);
        const pairedCount = accounts.list().filter(a => a.status.hasCreds).length;
        const inlineKeyboard = [
          [
            { text: `Route all (Spam)`, callback_data: `wacr:all:spam:${token}` },
            { text: 'Route & block all', callback_data: `wacr:all_block:spam:${token}` },
          ],
          [
            { text: 'Route (Scam/Fraud)', callback_data: `wacr:all:scam:${token}` },
            { text: 'Route (Harassment)', callback_data: `wacr:all:harass:${token}` },
          ],
          [
            { text: 'Solo report', callback_data: `wacr:solo:spam:${token}` },
            { text: 'Cancel', callback_data: `wacr:cancel:${token}` },
          ],
        ];

        return ctx.reply(
          [
            `Report this message from ${jidLabel(jid)} to WhatsApp?`,
            '',
            `"${preview}"`,
            '',
            'This is undocumented and cannot be undone. WhatsApp may answer with a report id, or not at all.',
          ].join('\n'),
          {
            reply_markup: {
              inline_keyboard: inlineKeyboard,
            },
          }
        );
      }
      case 'copy': {
        const last = inbox.lastText(jid, session.id);
        if (!last) {
          return ctx.reply(`Nothing to copy from ${jidLabel(jid)} yet. I only keep messages that arrive while the bot is connected.`);
        }
        return ctx.reply(`Last message from ${jidLabel(jid)}:\n\n${last.text}`);
      }
      case 'info': {
        const info = await chat.contactInfo(session, jid, country);
        const lines = [
          info.label,
          info.exists === null ? null : info.exists ? 'on WhatsApp' : 'not on WhatsApp',
          info.about ? `about: ${info.about}` : null,
          info.picture ? `photo: ${info.picture}` : 'no profile photo visible',
        ].filter(Boolean);
        return ctx.reply(lines.join('\n'));
      }
      default:
        return ctx.reply('I do not know that action.');
    }
  } catch (error) {
    log.warn('Chat action %s failed: %s', action, error.message);
    return ctx.reply(`Could not do that: ${error.message}`);
  }
}

async function openChat(ctx, session, rawJid) {
  const jid = toJid(rawJid, config.waDefaultCountry);
  if (!jid) return ctx.reply('That is not a valid number or group id.');
  setActiveChat(ctx.from.id, session.id, jid);
  return ctx.reply(`Chat: ${jidLabel(jid)}\nAccount: ${session.snapshot.label}\nWhat should I do with it?`, chatKeyboard());
}

function register(bot) {
  function notifyAdmins(text) {
    for (const adminId of config.adminIds) {
      bot.telegram.sendMessage(adminId, text).catch(error => log.debug('Admin notify failed: %s', error.message));
    }
  }

  accounts.subscribeAll((type, payload) => {
    const label = payload.label || `Account ${payload.id}`;
    if (type === 'open') notifyAdmins(`${label} connected as +${payload.number || 'unknown'}.`);
    if (type === 'loggedOut') notifyAdmins(`${label} session ended: ${payload.reason || 'logged out'}. Pair again with /pair.`);
    if (type === 'pairingFailed') notifyAdmins(`${label} pairing did not complete (${payload.reason || 'code not accepted'}). Send /pair for a fresh code.`);
    if (type === 'reconnectFailed') notifyAdmins(`${label} could not reconnect. Use /accounts to check it.`);
  });

  const showMenu = async (ctx, page = 0) => {
    const { reply_markup } = menuKeyboard(ctx.from.id, page);
    return ctx.reply(menuText(ctx.from.id, page), { reply_markup });
  };

  // --- commands -----------------------------------------------------------
  bot.command('wa', async ctx => {
    if (!requireAdmin(ctx)) return;
    return showMenu(ctx);
  });

  bot.command('accounts', async ctx => {
    if (!requireAdmin(ctx)) return;
    const rows = accounts.list();
    if (!rows.length) return showMenu(ctx);
    const current = accounts.active(ctx.from.id);
    const lines = rows.map(row => `${current && current.id === row.id ? '▸' : ' '} ${row.label}${row.phone ? ` +${row.phone}` : ''} · ${statusLine(accounts.get(row.id))}`);
    const connected = rows.filter(row => row.status.connected).length;
    // Telegram messages cap at 4096 characters, so a big fleet arrives in parts.
    const chunks = [];
    let buffer = `WhatsApp accounts (${rows.length}/${config.waMaxAccounts} linked, ${connected} connected):`;
    for (const line of lines) {
      if (buffer.length + line.length + 1 > 3500) {
        chunks.push(buffer);
        buffer = '';
      }
      buffer += `\n${line}`;
    }
    chunks.push(buffer);
    for (const chunk of chunks) await ctx.reply(chunk);
    return ctx.reply(`Active: ${current ? accountTag({ label: current.snapshot.label, status: { number: current.snapshot.number } }) : 'none'}`, menuKeyboard(ctx.from.id));
  });

  bot.command('account', async ctx => {
    if (!requireAdmin(ctx)) return;
    const arg = ctx.message.text.replace(/^\/account\s*/i, '').trim();
    if (!arg) return ctx.reply('Usage: /account <number> to switch, or /accounts to list.');
    const rows = accounts.list();
    const pick = /^\d+$/.test(arg)
      ? rows.find((row, index) => index + 1 === Number(arg) || row.id === Number(arg))
      : rows.find(row => row.label.toLowerCase() === arg.toLowerCase());
    if (!pick) return ctx.reply('No account matches that.');
    accounts.setActive(ctx.from.id, pick.id);
    clearStage(ctx.from.id);
    return ctx.reply(`Switched to ${pick.label}${pick.phone ? ` +${pick.phone}` : ''}.`);
  });

  bot.command('wipestale', async ctx => {
    if (!requireAdmin(ctx)) return;
    const rows = staleRows();
    if (!rows.length) return ctx.reply('Nothing to wipe: every session either is connected or still holds credentials.');
    const { text, reply_markup } = staleSummary('wa:wipestaledo');
    return ctx.reply(text, { reply_markup });
  });

  bot.command('pair', async ctx => {
    if (!requireAdmin(ctx)) return;
    const phone = ctx.message.text.replace(/^\/pair\s*/i, '').trim();
    if (!phone) {
      stage(ctx.from.id, 'pair');
      return ctx.reply('Send the phone number with country code, e.g. +233241234567. This adds it as a new account.');
    }
    return beginPairing(ctx, phone);
  });

  bot.command('unpair', async ctx => {
    if (!requireAdmin(ctx)) return;
    const session = sessionFor(ctx);
    if (!session) return;
    clearActiveChat(ctx.from.id, session.id);
    clearStage(ctx.from.id);
    await accounts.remove(session.id);
    return ctx.reply(`Unpaired ${session.snapshot.label} and deleted its saved session.`);
  });

  bot.command('send', async ctx => {
    if (!requireAdmin(ctx)) return;
    const session = sessionFor(ctx);
    if (!session) return;
    const rest = ctx.message.text.replace(/^\/send\s*/i, '').trim();
    const [destination, ...words] = rest.split(/\s+/);
    const text = words.join(' ').trim();
    if (!destination || !text) return ctx.reply('Usage: /send <number|group-id> <message>');
    return doSend(ctx, session, destination, text);
  });

  bot.command('chat', async ctx => {
    if (!requireAdmin(ctx)) return;
    const session = sessionFor(ctx);
    if (!session) return;
    const target = ctx.message.text.replace(/^\/chat\s*/i, '').trim();
    if (!target) {
      stage(ctx.from.id, 'chat_target');
      return ctx.reply('Which chat? Send a number with country code, or a group id ending in @g.us.');
    }
    return openChat(ctx, session, target);
  });

  bot.command('groups', async ctx => {
    if (!requireAdmin(ctx)) return;
    const session = sessionFor(ctx);
    if (!session) return;
    return replyGroups(ctx, session);
  });

  bot.command('media', async ctx => {
    if (!requireAdmin(ctx)) return;
    const session = sessionFor(ctx);
    if (!session) return;
    return replyMedia(ctx, session);
  });

  bot.command('reportall', async ctx => {
    if (!requireAdmin(ctx)) return;
    const session = sessionFor(ctx);
    if (!session) return;
    const targetRaw = ctx.message.text.replace(/^\/reportall\s*/i, '').trim();
    const jid = targetRaw ? toJid(targetRaw, config.waDefaultCountry) : getActiveChat(ctx.from.id, session.id);
    if (!jid) {
      return ctx.reply('Usage: /reportall <number|group-id>, or run it while in a chat.');
    }
    const [entry] = inbox.list({ accountId: session.id, jid, limit: 1 });
    if (!entry) {
      return ctx.reply(`No recent message from ${jidLabel(jid)} on ${session.snapshot.label} to report.`);
    }
    const token = createReportToken(ctx.from.id, session.id, entry);
    const preview = (entry.text || '(media without caption)').slice(0, 160);
    const pairedCount = accounts.list().filter(a => a.status.hasCreds).length;
    return ctx.reply(
      [
        `Route report for message from ${jidLabel(jid)} across all paired sessions?`,
        '',
        `"${preview}"`,
        '',
        `Targeting ${pairedCount || 1} paired session(s).`,
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `Route to all (${pairedCount || 1}) · Spam`, callback_data: `wacr:all:spam:${token}` },
              { text: 'Route & block all', callback_data: `wacr:all_block:spam:${token}` },
            ],
            [
              { text: 'Route (Scam/Fraud)', callback_data: `wacr:all:scam:${token}` },
              { text: 'Route (Harassment)', callback_data: `wacr:all:harass:${token}` },
            ],
            [
              { text: 'Cancel', callback_data: `wacr:cancel:${token}` },
            ],
          ],
        },
      }
    );
  });

  bot.command('cancelwa', ctx => {
    if (!requireAdmin(ctx)) return;
    clearStage(ctx.from.id);
    clearActiveChat(ctx.from.id);
    return ctx.reply('Cancelled.');
  });

  // --- menu buttons -------------------------------------------------------
  bot.action('wa:menu', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const page = Number(ctx.match?.[1] || 0) || 0;
    const { reply_markup } = menuKeyboard(ctx.from.id, page);
    await ctx.editMessageText(menuText(ctx.from.id, page), { reply_markup })
      .catch(() => ctx.reply(menuText(ctx.from.id, page), { reply_markup }));
    return ctx.answerCbQuery();
  });

  bot.action(/^wa:acctpage:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const page = Number(ctx.match[1]) || 0;
    await ctx.answerCbQuery();
    const { reply_markup } = menuKeyboard(ctx.from.id, page);
    return ctx.reply(menuText(ctx.from.id, page), { reply_markup });
  });

  bot.action('wa:noop', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery();
    return ctx.answerCbQuery('Use ‹ › to page through accounts.');
  });

  bot.action(/^wa:acct:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const id = Number(ctx.match[1]);
    if (!accounts.setActive(ctx.from.id, id)) {
      await ctx.answerCbQuery('Unknown account');
      return undefined;
    }
    clearStage(ctx.from.id);
    const session = accounts.get(id);
    await ctx.answerCbQuery(`Switched to ${session.snapshot.label}`);
    const index = accounts.list().findIndex(row => row.id === id);
    const page = index < 0 ? 0 : Math.floor(index / ACCOUNTS_PER_PAGE);
    const { reply_markup } = menuKeyboard(ctx.from.id, page);
    return ctx.reply(menuText(ctx.from.id, page), { reply_markup }).catch(() => undefined);
  });

  bot.action('wa:add', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    stage(ctx.from.id, 'pair');
    return ctx.reply('Send the phone number with country code, e.g. +233241234567.');
  });

  bot.action('wa:status', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    const rows = accounts.list();
    if (!rows.length) return ctx.reply('No accounts linked yet.');
    const lines = rows.map(row => {
      const session = accounts.get(row.id);
      return `${row.label}${row.phone ? ` +${row.phone}` : ''}: ${session ? statusLine(session) : 'no session'}`;
    });
    return ctx.reply(lines.join('\n'));
  });

  // Toggle entry point. The wipe itself needs a second press, so a mistap on
  // the menu cannot drop half the roster.
  bot.action('wa:wipestaleask', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    const rows = staleRows();
    if (!rows.length) return ctx.reply('Nothing to wipe: every session either is connected or still holds credentials.');
    const { text, reply_markup } = staleSummary('wa:wipestaledo');
    return ctx.reply(text, { reply_markup });
  });

  bot.action('wa:wipestaledo', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery('Wiping...');
    const result = await accounts.wipeStale();
    if (!result.wiped.length) return ctx.reply('Nothing to wipe.');
    return ctx.reply(
      `Wiped ${result.wiped.length} session(s): ${result.wiped.join(', ')}.\n` +
      `${result.remaining} account(s) left.`,
    );
  });

  bot.action('wa:unpairask', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const session = accounts.active(ctx.from.id);
    if (!session) {
      await ctx.answerCbQuery();
      return ctx.reply('No account is active.');
    }
    await ctx.answerCbQuery();
    return ctx.reply(
      `Unpair ${session.snapshot.label}${session.snapshot.number ? ` +${session.snapshot.number}` : ''}?\n\nThis logs out that WhatsApp account and deletes its saved session. The other accounts are untouched.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Unpair it', callback_data: `wa:unpairdo:${session.id}` },
            { text: 'Cancel', callback_data: 'wa:menu' },
          ]],
        },
      }
    );
  });

  bot.action(/^wa:unpairdo:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const id = Number(ctx.match[1]);
    const session = accounts.get(id);
    if (!session) {
      await ctx.answerCbQuery('Already gone');
      return undefined;
    }
    await ctx.answerCbQuery('Unpairing…');
    const label = session.snapshot.label;
    clearActiveChat(ctx.from.id, id);
    clearStage(ctx.from.id);
    await accounts.remove(id);
    return ctx.reply(`${label} unpaired and its session deleted.`);
  });

  bot.action('wa:pair', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    stage(ctx.from.id, 'pair');
    return ctx.reply('Send the phone number with country code, e.g. +233241234567.');
  });

  bot.action('wa:unpair', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const session = accounts.active(ctx.from.id);
    if (!session) {
      await ctx.answerCbQuery();
      return ctx.reply('No account is active.');
    }
    await ctx.answerCbQuery('Unpairing…');
    clearActiveChat(ctx.from.id, session.id);
    clearStage(ctx.from.id);
    await accounts.remove(session.id);
    return ctx.reply(`${session.snapshot.label} unpaired.`);
  });

  bot.action('wa:send', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    if (!accounts.active(ctx.from.id)) return ctx.reply('Add an account first with /pair <number>.');
    stage(ctx.from.id, 'send_to');
    return ctx.reply('Who is it going to? Send a number with country code, or a group id ending in @g.us.');
  });

  bot.action('wa:check', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    stage(ctx.from.id, 'check');
    return ctx.reply('Which number should I check? Include the country code.');
  });

  bot.action('wa:recent', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    const rows = db.listSends(8);
    if (!rows.length) return ctx.reply('Nothing sent from here yet.');
    const byId = new Map(accounts.list().map(row => [row.id, row.label]));
    const lines = rows.map(r => `${r.status === 'sent' ? '✓' : '✗'} ${byId.get(r.account_id) || 'account ?'} → ${jidLabel(r.jid)} · ${r.created_at.slice(0, 16).replace('T', ' ')}\n   ${r.body_preview || '(no text)'}${r.error ? `\n   error: ${r.error}` : ''}`);
    return ctx.reply(lines.join('\n'));
  });

  bot.action('wa:chat', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    if (!accounts.active(ctx.from.id)) return ctx.reply('Add an account first with /pair <number>.');
    stage(ctx.from.id, 'chat_target');
    return ctx.reply('Which chat? Send a number with country code, or a group id ending in @g.us.');
  });

  bot.action('wa:groups', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    const session = sessionFor(ctx);
    if (!session) return undefined;
    return replyGroups(ctx, session);
  });

  bot.action('wa:media', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    const session = sessionFor(ctx);
    if (!session) return undefined;
    return replyMedia(ctx, session);
  });

  // --- media download -----------------------------------------------------
  bot.action(/^wa:m:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery('Fetching…');
    return sendMediaToTelegram(ctx, ctx.match[1]);
  });

  // --- chat actions -------------------------------------------------------
  bot.action(/^wac:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const action = ctx.match[1];
    const session = sessionFor(ctx);
    if (!session) {
      await ctx.answerCbQuery();
      return undefined;
    }
    const jid = getActiveChat(ctx.from.id, session.id);
    if (!jid) {
      await ctx.answerCbQuery();
      return ctx.reply('Pick a chat first with /chat <number or group>.');
    }
    await ctx.answerCbQuery();

    if (action === 'send') {
      stage(ctx.from.id, 'send_text', { jid });
      return ctx.reply(`Message for ${jidLabel(jid)}? Send the text now.`);
    }
    if (action === 'media') return replyMedia(ctx, session, jid);
    return runChatAction(ctx, session, jid, action);
  });

  // --- report confirmation -------------------------------------------------
  bot.action(/^wacr:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const raw = ctx.match[1];
    const parts = raw.split(':');
    let choice, categoryKey, token;
    if (parts.length === 2) {
      [choice, token] = parts;
      categoryKey = 'spam';
    } else {
      [choice, categoryKey, token] = parts;
    }

    const SPAM_FLOWS = {
      spam: '1',
      scam: '3',
      harass: '2',
      offensive: '4',
      general: 'MessageMenu',
    };
    const flow = SPAM_FLOWS[categoryKey] || '1';

    if (!token || !pendingReports.has(token)) {
      await ctx.answerCbQuery('Invalid or expired');
      return ctx.reply('This report confirmation request is invalid, expired, or already processed.');
    }

    const pending = pendingReports.get(token);
    if (pending.adminId !== ctx.from.id) {
      return ctx.answerCbQuery('Only the administrator who initiated this report can confirm it.');
    }

    if (pending.consumed) {
      await ctx.answerCbQuery('Already processed');
      return ctx.reply('This report request has already been processed.');
    }

    if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
      pendingReports.delete(token);
      await ctx.answerCbQuery('Expired');
      return ctx.reply('This report confirmation request has expired.');
    }

    if (choice === 'cancel') {
      pending.consumed = true;
      pendingReports.delete(token);
      await ctx.answerCbQuery();
      return ctx.reply('Report cancelled.');
    }

    // Mark consumed synchronously to prevent duplicate callback execution / double-taps
    pending.consumed = true;
    pendingReports.delete(token);

    const session = accounts.get(pending.accountId);
    if (!session) {
      await ctx.answerCbQuery('Account unavailable');
      return ctx.reply('The WhatsApp account used to initiate this report is no longer available.');
    }

    const entry = inbox.get(pending.entryId);
    if (!entry || entry.jid !== pending.jid) {
      await ctx.answerCbQuery('Message unavailable');
      return ctx.reply('That message is no longer in the recent buffer, so there is nothing to report.');
    }

    let subject = null;
    if (entry.isGroup) {
      subject = await chat.groupMembers(session, entry.jid, 1, config.waDefaultCountry)
        .then(info => info.subject).catch(() => null);
    }

    const isAll = choice === 'all' || choice === 'all_block';
    const doBlock = choice === 'block' || choice === 'all_block';

    if (isAll) {
      await ctx.answerCbQuery('Routing report across paired sessions…');
      try {
        const pairedRows = accounts.list().filter(a => a.status.hasCreds);
        const sessionsToRoute = pairedRows.map(r => accounts.get(r.id)).filter(Boolean);
        if (!sessionsToRoute.length) sessionsToRoute.push(session);

        const results = await chat.reportMessageAll(sessionsToRoute, entry, { block: doBlock, subject, flow });

        const lines = [`Report routed through ${results.length} paired session(s):`];
        for (const r of results) {
          const iden = r.number ? `${r.label} (${r.number})` : r.label;
          if (r.status === 'confirmed') {
            lines.push(`• ${iden}: Confirmed (id ${r.reportId})`);
          } else if (r.status === 'unconfirmed') {
            lines.push(`• ${iden}: Answered without report id`);
          } else if (r.status === 'unanswered') {
            lines.push(`• ${iden}: Unanswered`);
          } else if (r.status === 'disconnected') {
            lines.push(`• ${iden}: Skipped (disconnected)`);
          } else if (r.status === 'error') {
            lines.push(`• ${iden}: Error response from server`);
          } else {
            lines.push(`• ${iden}: Failed (${r.error || r.status})`);
          }
        }
        if (doBlock) lines.push('\nBlock applied across available sessions.');
        return ctx.reply(lines.join('\n'));
      } catch (error) {
        log.warn('Report route failed: %s', error.message);
        return ctx.reply(`Could not route report: ${error.message}`);
      }
    }

    // Solo report: only reports through the active session without automatic cascading
    await ctx.answerCbQuery(doBlock ? 'Reporting and blocking…' : 'Reporting…');
    try {
      const result = await chat.reportMessage(session, entry, { block: doBlock, subject, flow });
      const lines = [];
      if (result.status === 'confirmed') {
        lines.push(`WhatsApp accepted the report (id ${result.reportId}). That is the server acknowledging it, not a promise of removal.`);
      } else if (result.status === 'unconfirmed') {
        lines.push('WhatsApp answered without a report id. Treat the report as unconfirmed.');
      } else if (result.status === 'unanswered') {
        lines.push(`WhatsApp never answered within ${Math.round(config.waQueryTimeoutMs / 1000)}s. The report may not have been accepted.`);
      } else if (result.status === 'disconnected') {
        lines.push(`${session.snapshot.label} is disconnected. Report was not delivered.`);
      } else if (result.status === 'error') {
        lines.push('WhatsApp rejected the report with an error response.');
      } else {
        lines.push(`Unexpected report result (${result.status}).`);
      }

      if (doBlock) {
        if (result.blocked) {
          lines.push(`${jidLabel(result.jid)} is blocked.`);
        } else if (result.blockError) {
          lines.push(`Could not block ${jidLabel(result.jid)}: ${result.blockError}`);
        }
      } else {
        lines.push('Not blocked; block with the Block button if you want to.');
      }

      if (result.status !== 'confirmed') lines.push('Reporting from the phone as well is the safer bet.');
      return ctx.reply(lines.join('\n'));
    } catch (error) {
      log.warn('Report failed: %s', error.message);
      return ctx.reply(`Could not report: ${error.message}`);
    }
  });

  // --- group picked from the list -----------------------------------------
  bot.action(/^wa:g:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const jid = ctx.match[1];
    const session = sessionFor(ctx);
    await ctx.answerCbQuery();
    if (!session) return undefined;
    setActiveChat(ctx.from.id, session.id, jid);
    return ctx.reply(`Group: ${jidLabel(jid)}\nAccount: ${session.snapshot.label}`, groupKeyboard());
  });

  bot.action(/^wag:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const action = ctx.match[1];
    const session = sessionFor(ctx);
    if (!session) {
      await ctx.answerCbQuery();
      return undefined;
    }
    const jid = getActiveChat(ctx.from.id, session.id);
    if (!jid) {
      await ctx.answerCbQuery();
      return ctx.reply('Pick a group from /groups first.');
    }
    await ctx.answerCbQuery();

    if (action === 'send') {
      stage(ctx.from.id, 'send_text', { jid });
      return ctx.reply(`Message for ${jidLabel(jid)}? Send the text now.`);
    }
    try {
      if (action === 'link') {
        const { link } = await chat.groupInvite(session, jid, config.waDefaultCountry);
        return ctx.reply(`Invite link for ${jidLabel(jid)}:\n${link}`);
      }
      if (action === 'members') {
        const info = await chat.groupMembers(session, jid, 30, config.waDefaultCountry);
        const lines = info.members.map(m => `${m.admin ? '*' : '-'} ${m.jid}`);
        return ctx.reply(`${info.subject} · ${info.total} members\n${lines.join('\n')}`);
      }
      if (action === 'leave') {
        await chat.leaveGroup(session, jid, config.waDefaultCountry);
        clearActiveChat(ctx.from.id, session.id);
        return ctx.reply(`Left ${jidLabel(jid)} with ${session.snapshot.label}.`);
      }
      return ctx.reply('I do not know that action.');
    } catch (error) {
      log.warn('Group action %s failed: %s', action, error.message);
      return ctx.reply(`Could not do that: ${error.message}`);
    }
  });

  // --- staged text input --------------------------------------------------
  bot.on('text', async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const step = pendingInput.get(ctx.from.id);
    if (!step || ctx.message.text.startsWith('/')) return next();
    const text = ctx.message.text.trim();

    if (step.step === 'pair') {
      clearStage(ctx.from.id);
      return beginPairing(ctx, text);
    }

    if (step.step === 'send_to' || step.step === 'chat_target') {
      const session = sessionFor(ctx);
      if (!session) return true;
      const jid = toJid(text, config.waDefaultCountry);
      if (!jid) {
        await ctx.reply('That is not a valid number or group id. Try again, or /cancelwa.');
        return true;
      }
      clearStage(ctx.from.id);
      if (step.step === 'chat_target') return openChat(ctx, session, jid);
      stage(ctx.from.id, 'send_text', { jid });
      await ctx.reply(`Message for ${jidLabel(jid)} from ${session.snapshot.label}? Send the text now.`);
      return true;
    }

    if (step.step === 'send_text') {
      const session = sessionFor(ctx);
      if (!session) return true;
      clearStage(ctx.from.id);
      return doSend(ctx, session, step.jid, text);
    }

    if (step.step === 'check') {
      const session = sessionFor(ctx);
      if (!session) return true;
      clearStage(ctx.from.id);
      try {
        const result = await session.checkNumber(text);
        await ctx.reply(result.exists
          ? `+${result.digits} is on WhatsApp (${result.jid}) according to ${session.snapshot.label}.`
          : `+${result.digits} does not appear to have WhatsApp.`);
      } catch (error) {
        await ctx.reply(`Could not check that number: ${error.message}`);
      }
      return true;
    }

    return next();
  });
}

module.exports = {
  register, statusLine, menuText, menuKeyboard, chatKeyboard, groupKeyboard,
  MUTE_OPTIONS, accountTag,
  _testHooks: {
    pendingReports, createReportToken, clearActiveChat, getActiveChat, setActiveChat,
  },
};
