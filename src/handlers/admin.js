const config = require('../config');
const db = require('../db');
const log = require('../utils/logger');

const TELEGRAM_LIMIT = 4000;

function isAdmin(ctx) {
  return config.adminIds.includes(ctx.from?.id);
}

function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;
  ctx.reply('This command is restricted to administrators.');
  return false;
}

function formatItem(item) {
  const who = item.username ? `@${item.username}` : item.first_name || String(item.user_id);
  return `#${item.id} · ${who}\n${item.text}\n${item.created_at}`;
}

// Telegram rejects messages over 4096 characters, so a full inbox is split instead of truncated.
function chunkItems(items, limit = TELEGRAM_LIMIT) {
  const chunks = [];
  let current = '';
  for (const block of items.map(formatItem)) {
    if (current && current.length + block.length + 2 > limit) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function notify(ctx, userId, text) {
  try {
    await ctx.telegram.sendMessage(userId, text);
    return true;
  } catch (error) {
    log.warn('Could not notify user %s: %s', userId, error.message);
    return false;
  }
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function register(bot) {
  bot.command('inbox', async ctx => {
    if (!requireAdmin(ctx)) return;
    const page = Math.max(1, parseId(ctx.message.text.split(/\s+/)[1]) || 1);
    const pageSize = config.inboxPageSize;
    const items = db.listOpenFeedback(pageSize, (page - 1) * pageSize);
    if (!items.length) {
      return ctx.reply(page === 1 ? 'Inbox is empty.' : `No open feedback on page ${page}.`);
    }
    for (const chunk of chunkItems(items)) {
      await ctx.reply(chunk);
    }
    const { open } = db.feedbackCounts();
    const pages = Math.max(1, Math.ceil(open / pageSize));
    return ctx.reply(`Page ${page} of ${pages} · ${open} open`);
  });

  bot.command('reply', async ctx => {
    if (!requireAdmin(ctx)) return;
    const [, rawId, ...rest] = ctx.message.text.split(/\s+/);
    const id = parseId(rawId);
    const body = rest.join(' ').trim();
    if (!id || !body) return ctx.reply('Usage: /reply <feedback_id> <message>');

    const item = db.getFeedback(id);
    if (!item) return ctx.reply(`Feedback #${id} not found.`);
    if (item.status !== 'open') return ctx.reply(`Feedback #${id} is already resolved.`);

    const delivered = await notify(ctx, item.user_id, `Reply to your feedback #${item.id}:\n\n${body}`);
    if (!delivered) return ctx.reply(`Could not deliver the reply to the reporter (they may have blocked the bot). Feedback #${id} left open.`);

    db.replyFeedback(id, body, ctx.from.id);
    return ctx.reply(`Replied to #${id} and marked it resolved.`);
  });

  bot.command('resolve', async ctx => {
    if (!requireAdmin(ctx)) return;
    const id = parseId(ctx.message.text.split(/\s+/)[1]);
    if (!id) return ctx.reply('Usage: /resolve <feedback_id>');

    const item = db.getFeedback(id);
    if (!item) return ctx.reply(`Feedback #${id} not found.`);
    if (!db.resolveFeedback(id, ctx.from.id)) return ctx.reply(`Feedback #${id} was already resolved.`);

    await notify(ctx, item.user_id, `Your feedback #${item.id} has been reviewed and closed. Thank you.`);
    return ctx.reply(`Feedback #${id} resolved.`);
  });

  bot.command('adminstats', async ctx => {
    if (!requireAdmin(ctx)) return;
    const counts = db.feedbackCounts();
    await ctx.reply(`Feedback total: ${counts.total}\nOpen: ${counts.open}`);
  });

  bot.command('adminhelp', ctx => {
    if (!requireAdmin(ctx)) return;
    return ctx.reply(
      [
        '/inbox [page] - list open feedback',
        '/reply <id> <message> - answer the reporter and close the item',
        '/resolve <id> - close without a reply',
        '/adminstats - totals',
      ].join('\n')
    );
  });
}

module.exports = { register, isAdmin };
