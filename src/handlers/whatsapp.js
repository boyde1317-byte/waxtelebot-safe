// Telegram-side controls for the WhatsApp session: pairing, sending, groups.
const config = require('../config');
const db = require('../db');
const log = require('../utils/logger');
const wa = require('../whatsapp/session');
const { toJid, jidLabel } = require('../whatsapp/jid');

const pendingInput = new Map(); // adminId -> { step, jid }

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
          { text: 'My groups', callback_data: 'wa:groups' },
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
    'Pick an action below, or use:',
    '/pair <number> · /send <number|group> <text> · /groups · /unpair',
  ].join('\n');
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

  bot.command('groups', async ctx => {
    if (!requireAdmin(ctx)) return;
    return replyGroups(ctx);
  });

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

  bot.action('wa:groups', async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    await ctx.answerCbQuery();
    return replyGroups(ctx);
  });

  // Group picked from the /groups buttons
  bot.action(/^wa:g:(.+)$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only.');
    const jid = ctx.match[1];
    await ctx.answerCbQuery();
    stage(ctx.from.id, 'send_text', { jid });
    return ctx.reply(`Message for ${jidLabel(jid)}? Send the text now.`);
  });

  // Staged text input: runs before the feedback prompt handler.
  bot.on('text', async (ctx, next) => {
    const step = pendingInput.get(ctx.from.id);
    if (!step || ctx.message.text.startsWith('/')) return next();
    const text = ctx.message.text.trim();

    if (step.step === 'pair') {
      clearStage(ctx.from.id);
      return beginPairing(ctx, text);
    }

    if (step.step === 'send_to') {
      const jid = toJid(text, config.waDefaultCountry);
      if (!jid) {
        await ctx.reply('That is not a valid number or group id. Try again, or /cancel.');
        return true;
      }
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

  bot.command('cancelwa', ctx => {
    if (!requireAdmin(ctx)) return;
    clearStage(ctx.from.id);
    return ctx.reply('Cancelled.');
  });
}

module.exports = { register, statusLine, menuText, menuKeyboard };
