// Telegram-side controls for the WhatsApp session: pairing, sending, chat actions, media.
const { Input } = require('telegraf');
const config = require('../config');
const db = require('../db');
const log = require('../utils/logger');
const wa = require('../whatsapp/session');
const chat = require('../whatsapp/chat');
const inbox = require('../whatsapp/inbox');
const { toJid, jidLabel } = require('../whatsapp/jid');

const pendingInput = new Map(); // adminId -> { step, jid }
const activeChat = new Map(); // adminId -> jid the chat buttons act on

const MUTE_OPTIONS = {
  mute8: { label: 'Muted for 8 hours', ms: 8 * 60 * 60 * 1000 },
  mute1w: { label: 'Muted for a week', ms: 7 * 24 * 60 * 60 * 1000 },
  muteAlways: { label: 'Muted until you unmute it', ms: 100 * 365 * 24 * 60 * 60 * 1000 },
  unmute: { label: 'Unmuted', ms: null },
};

function isAdmin(ctx) {
  return config.adminIds.includes(ctx.from?.id);
}

function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;
  ctx.reply('This command is restricted to administrators.');
  return false;
}

function statusLine() {
  const s = wa.status();
  const bits = [s.connected ? 'Connected' : `Not connected (${s.state})`];
  if (s.number) bits.push(`+${s.number}`);
  if (s.connected && s.since) bits.push(`since ${s.since.slice(0, 16).replace('T', ' ')}Z`);
  if (!s.connected && s.lastError) bits.push(s.lastError);
  if (!s.hasCreds) bits.push('no saved session');
  return bits.join(' · ');
}

function menuKeyboard() {
  const connected = wa.status().connected;
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Status', callback_data: 'wa:status' },
          { text: connected ? 'Unpair' : 'Pair by code', callback_data: connected ? 'wa:unpair' : 'wa:pair' },
        ],
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
      ],
    },
  };
}

function menuText() {
  return [
    'WhatsApp',
    statusLine(),
    '',
    'Pick an action, or use a command:',
    '/pair <number> · /send <number|group> <text> · /chat <number|group>',
    '/groups · /media · /unpair · /cancelwa',
  ].join('\n');
}

function chatKeyboard(jid) {
  const actions = [
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
  ];
  return { text: `Chat: ${jidLabel(jid)}\nWhat should I do with it?`, reply_markup: { inline_keyboard: actions } };
}

function groupKeyboard(jid) {
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

async function beginPairing(ctx, phone) {
  await ctx.reply('Requesting a pairing code from WhatsApp…');
  try {
    const result = await wa.connect({ phone });
    const code = result?.code;
    if (!code) return ctx.reply(`Already paired as +${result?.number || 'unknown'}.`);
    return ctx.reply(
      [
        `Pairing code: ${code}`,
        '',
        'On the phone with that WhatsApp account:',
        'Settings → Linked devices → Link a device → Link with phone number instead.',
        'Enter the code above. It expires in about a minute.',
      ].join('\n')
    );
  } catch (error) {
    log.warn('Pairing failed: %s', error.message);
    return ctx.reply(`Could not start pairing: ${error.message}`);
  }
}

async function doSend(ctx, rawJid, text) {
  try {
    const result = await wa.sendText({ rawJid, text, adminId: ctx.from.id });
    return ctx.reply(`Sent to ${jidLabel(result.jid)}.`);
  } catch (error) {
    log.warn('Send failed: %s', error.message);
    return ctx.reply(`Could not send: ${error.message}`);
  }
}

async function replyGroups(ctx) {
  try {
    const groups = await wa.listGroups();
    if (!groups.length) return ctx.reply('This account is not in any groups.');
    const lines = groups.map((g, i) => `${i + 1}. ${g.subject} · ${g.participants} members\n   ${g.jid}`);
    const rows = groups.slice(0, 8).map(g => [{ text: g.subject.slice(0, 40), callback_data: `wa:g:${g.jid}` }]);
    return ctx.reply(`Groups:\n${lines.join('\n')}`, {
      reply_markup: rows.length ? { inline_keyboard: rows } : undefined,
    });
  } catch (error) {
    return ctx.reply(`Could not load groups: ${error.message}`);
  }
}

async function replyMedia(ctx, jid = null) {
  const items = inbox.list({ jid, kind: 'media', limit: 8 });
  if (!items.length) {
    return ctx.reply('Nothing recent. Media shows up here once it arrives while the bot is connected.');
  }
  const rows = items.map(item => [{
    text: `${inbox.label(item)}`.slice(0, 60),
    callback_data: `wa:m:${item.id}`,
  }]);
  return ctx.reply('Recent media. Tap one to bring it here.', { reply_markup: { inline_keyboard: rows } });
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

// Runs one chat action and reports the outcome.
async function runChatAction(ctx, jid, action) {
  const country = config.waDefaultCountry;
  const mute = MUTE_OPTIONS[action];

  try {
    if (mute) {
      await chat.setMute(jid, mute.ms, country);
      return ctx.reply(`${jidLabel(jid)}: ${mute.label}.`);
    }
    switch (action) {
      case 'pin':
        await chat.setPin(jid, true, country);
        return ctx.reply(`${jidLabel(jid)} pinned.`);
      case 'unpin':
        await chat.setPin(jid, false, country);
        return ctx.reply(`${jidLabel(jid)} unpinned.`);
      case 'archive':
        await chat.setArchive(jid, true, country);
        return ctx.reply(`${jidLabel(jid)} archived.`);
      case 'unarchive':
        await chat.setArchive(jid, false, country);
        return ctx.reply(`${jidLabel(jid)} unarchived.`);
      case 'read':
        await chat.markRead(jid, country);
        return ctx.reply(`${jidLabel(jid)} marked as read.`);
      case 'clear':
        await chat.clearChat(jid, country);
        return ctx.reply(`Messages cleared from ${jidLabel(jid)}.`);
      case 'delete':
        await chat.deleteChat(jid, country);
        activeChat.delete(ctx.from.id);
        return ctx.reply(`${jidLabel(jid)} deleted from the chat list.`);
      case 'block':
        await chat.setBlocked(jid, true, country);
        return ctx.reply(`${jidLabel(jid)} blocked.`);
      case 'report':
        return ctx.reply(
          `Report ${jidLabel(jid)} to WhatsApp?\n\nThis sends a spam report from your account and cannot be undone. WhatsApp does not tell us whether it was received.`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Report', callback_data: 'wacr:solo' },
                { text: 'Report and block', callback_data: 'wacr:block' },
              ], [
                { text: 'Cancel', callback_data: 'wacr:cancel' },
              ]],
            },
          }
        );
      case 'copy': {
        const last = inbox.lastText(jid);
        if (!last) {
          return ctx.reply(`Nothing to copy from ${jidLabel(jid)} yet. I only keep messages that arrive while the bot is connected.`);
        }
        return ctx.reply(`Last message from ${jidLabel(jid)}:\n\n${last.text}`);
      }
      case 'unblock':
        await chat.setBlocked(jid, false, country);
        return ctx.reply(`${jidLabel(jid)} unblocked.`);
      case 'info': {
        const info = await chat.contactInfo(jid, country);
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

async function openChat(ctx, rawJid) {
  const jid = toJid(rawJid, config.waDefaultCountry);
  if (!jid) return ctx.reply('That is not a valid number or group id.');
  activeChat.set(ctx.from.id, jid);
  const { text, reply_markup } = chatKeyboard(jid);
  return ctx.reply(text, { reply_markup });
}

function register(bot) {
  function notifyAdmins(text) {
    for (const adminId of config.adminIds) {
      bot.telegram.sendMessage(adminId, text).catch(error => log.debug('Admin notify failed: %s', error.message));
    }
  }

  wa.subscribe((type, payload) => {
    if (type === 'open') notifyAdmins(`WhatsApp connected as +${payload.number || 'unknown'}.`);
    if (type === 'loggedOut') notifyAdmins(`WhatsApp session ended: ${payload.reason || 'logged out'}. Pair again with /wa.`);
    if (type === 'pairingFailed') notifyAdmins(`Pairing did not complete (${payload.reason || 'code not accepted'}). Send /pair for a fresh code.`);
    if (type === 'reconnectFailed') notifyAdmins('WhatsApp could not reconnect. Use /wa to check and pair again.');
  });

  // --- commands -----------------------------------------------------------
  bot.command('wa', async ctx => {
    if (!requireAdmin(ctx)) return;
    return ctx.reply(menuText(), menuKeyboard());
  });

  bot.command('pair', async ctx => {
    if (!requireAdmin(ctx)) return;
    const phone = ctx.message.text.replace(/^\/pair\s*/i, '').trim();
    if (!phone) {
      stage(ctx.from.id, 'pair');
      return ctx.reply('Send the phone number with country code, e.g. +233241234567.');
    }
    return beginPairing(ctx, phone);
  });

  bot.command('unpair', async ctx => {
    if (!requireAdmin(ctx)) return;
    await wa.logout();
    return ctx.reply('WhatsApp unpaired and the saved session was deleted.');
  });

  bot.command('send', async ctx => {
    if (!requireAdmin(ctx)) return;
    const rest = ctx.message.text.replace(/^\/send\s*/i, '').trim();
    const [destination, ...words] = rest.split(/\s+/);
    const text = words.join(' ').trim();
    if (!destination || !text) return ctx.reply('Usage: /send <number|group-id> <message>');
    return doSend(ctx, destination, text);
  });

  bot.command('chat', async ctx => {
    if (!requireAdmin(ctx)) return;
    const target = ctx.message.text.replace(/^\/chat\s*/i, '').trim();
    if (!target) {
      stage(ctx.from.id, 'chat_target');
      return ctx.reply('Which chat? Send a number with country code, or a group id ending in @g.us.');
    }
    return openChat(ctx, target);
  });

  bot.command('groups', async ctx => {
    if (!requireAdmin(ctx)) return;
    return replyGroups(ctx);
  });

  bot.command('media', async ctx => {
    if (!requireAdmin(ctx)) return;
    return replyMedia(ctx);
  });

  bot.command('cancelwa', ctx => {
    if (!requireAdmin(ctx)) return;
    clearStage(ctx.from.id);
    activeChat.delete(ctx.from.id);
    return ctx.reply('Cancelled.');
  });

  // --- menu buttons -------------------------------------------------------
  bot.action('wa:menu', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.editMessageText(menuText(), menuKeyboard()).catch(() => ctx.reply(menuText(), menuKeyboard()));
    return ctx.answerCbQuery();
  });

  bot.action('wa:status', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    return ctx.reply(statusLine());
  });

  bot.action('wa:pair', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    stage(ctx.from.id, 'pair');
    return ctx.reply('Send the phone number with country code, e.g. +233241234567.');
  });

  bot.action('wa:unpair', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    await wa.logout();
    return ctx.reply('WhatsApp unpaired and the saved session was deleted.');
  });

  bot.action('wa:send', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
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
    const lines = rows.map(r => `${r.status === 'sent' ? '✓' : '✗'} ${jidLabel(r.jid)} · ${r.created_at.slice(0, 16).replace('T', ' ')}\n   ${r.body_preview || '(no text)'}${r.error ? `\n   error: ${r.error}` : ''}`);
    return ctx.reply(lines.join('\n'));
  });

  bot.action('wa:chat', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    stage(ctx.from.id, 'chat_target');
    return ctx.reply('Which chat? Send a number with country code, or a group id ending in @g.us.');
  });

  bot.action('wa:groups', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    return replyGroups(ctx);
  });

  bot.action('wa:media', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    return replyMedia(ctx);
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
    const jid = activeChat.get(ctx.from.id);
    if (!jid) {
      await ctx.answerCbQuery();
      return ctx.reply('Pick a chat first with /chat <number or group>.');
    }
    await ctx.answerCbQuery();

    if (action === 'send') {
      stage(ctx.from.id, 'send_text', { jid });
      return ctx.reply(`Message for ${jidLabel(jid)}? Send the text now.`);
    }
    if (action === 'media') return replyMedia(ctx, jid);
    return runChatAction(ctx, jid, action);
  });

  // --- report confirmation -------------------------------------------------
  bot.action(/^wacr:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const choice = ctx.match[1];
    const jid = activeChat.get(ctx.from.id);
    if (!jid) {
      await ctx.answerCbQuery();
      return ctx.reply('Pick a chat first with /chat <number or group>.');
    }
    if (choice === 'cancel') {
      await ctx.answerCbQuery();
      return ctx.reply('Report cancelled.');
    }
    await ctx.answerCbQuery('Reporting…');
    try {
      const result = await chat.report(jid, { block: choice === 'block' }, config.waDefaultCountry);
      return ctx.reply(
        `Report sent for ${jidLabel(result.jid)}${result.blocked ? ', and blocked' : ''}.\nIf nothing changes on the phone, report from there as well: WhatsApp treats this as a signal, not a guaranteed removal.`
      );
    } catch (error) {
      log.warn('Report failed: %s', error.message);
      return ctx.reply(`Could not report: ${error.message}`);
    }
  });

  // --- group picked from the list -----------------------------------------
  bot.action(/^wa:g:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const jid = ctx.match[1];
    await ctx.answerCbQuery();
    activeChat.set(ctx.from.id, jid);
    return ctx.reply(`Group: ${jidLabel(jid)}`, groupKeyboard(jid));
  });

  bot.action(/^wag:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const action = ctx.match[1];
    const jid = activeChat.get(ctx.from.id);
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
        const { link } = await chat.groupInvite(jid, config.waDefaultCountry);
        return ctx.reply(`Invite link for ${jidLabel(jid)}:\n${link}`);
      }
      if (action === 'members') {
        const info = await chat.groupMembers(jid, 30, config.waDefaultCountry);
        const lines = info.members.map(m => `${m.admin ? '*' : '-'} ${m.jid}`);
        return ctx.reply(`${info.subject} · ${info.total} members\n${lines.join('\n')}`);
      }
      if (action === 'leave') {
        await chat.leaveGroup(jid, config.waDefaultCountry);
        activeChat.delete(ctx.from.id);
        return ctx.reply(`Left ${jidLabel(jid)}.`);
      }
      return ctx.reply('I do not know that action.');
    } catch (error) {
      log.warn('Group action %s failed: %s', action, error.message);
      return ctx.reply(`Could not do that: ${error.message}`);
    }
  });

  // --- staged text input --------------------------------------------------
  bot.on('text', async (ctx, next) => {
    const step = pendingInput.get(ctx.from.id);
    if (!step || ctx.message.text.startsWith('/')) return next();
    const text = ctx.message.text.trim();

    if (step.step === 'pair') {
      clearStage(ctx.from.id);
      return beginPairing(ctx, text);
    }

    if (step.step === 'send_to' || step.step === 'chat_target') {
      const jid = toJid(text, config.waDefaultCountry);
      if (!jid) {
        await ctx.reply('That is not a valid number or group id. Try again, or /cancelwa.');
        return true;
      }
      clearStage(ctx.from.id);
      if (step.step === 'chat_target') return openChat(ctx, jid);
      stage(ctx.from.id, 'send_text', { jid });
      await ctx.reply(`Message for ${jidLabel(jid)}? Send the text now.`);
      return true;
    }

    if (step.step === 'send_text') {
      clearStage(ctx.from.id);
      return doSend(ctx, step.jid, text);
    }

    if (step.step === 'check') {
      clearStage(ctx.from.id);
      try {
        const result = await wa.checkNumber(text);
        await ctx.reply(result.exists
          ? `+${result.digits} is on WhatsApp (${result.jid}).`
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
  MUTE_OPTIONS,
};
