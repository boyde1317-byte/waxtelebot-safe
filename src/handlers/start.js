const config = require('../config');
const db = require('../db');

const pending = new Map(); // userId -> prompt expiry (epoch ms)
const lastSubmission = new Map(); // userId -> epoch ms of previous submission

function isPending(userId) {
  const expiresAt = pending.get(userId);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    pending.delete(userId);
    return false;
  }
  return true;
}

function formatStatus(item) {
  return item.status === 'open' ? 'open' : 'resolved';
}

async function submit(ctx, rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    await ctx.reply(`Feedback cannot be empty. Send /feedback <message>, or /feedback on its own to be prompted.`);
    return false;
  }
  if (text.length > config.feedbackMaxLen) {
    await ctx.reply(`That is ${text.length} characters; the limit is ${config.feedbackMaxLen}. Please shorten it and send again.`);
    return false;
  }

  const waitMs = config.rateLimitSeconds * 1000;
  const previous = lastSubmission.get(ctx.from.id) || 0;
  const elapsed = Date.now() - previous;
  if (elapsed < waitMs) {
    const seconds = Math.ceil((waitMs - elapsed) / 1000);
    await ctx.reply(`You just sent feedback. You can send more in ${seconds}s.`);
    return false;
  }

  db.upsertUser(ctx.from);
  const item = db.createFeedback(ctx.from.id, text);
  lastSubmission.set(ctx.from.id, Date.now());
  await ctx.reply(`Feedback #${item.id} received. Thank you.`);
  return true;
}

function register(bot) {
  bot.start(async ctx => {
    db.upsertUser(ctx.from);
    await ctx.reply('Welcome. Use /feedback to send a message to the support team, or /help for commands.');
  });

  bot.command('help', ctx => ctx.reply(
    [
      '/start - subscribe',
      '/feedback <message> - send feedback',
      '/feedback - get prompted for the next message',
      '/myfeedback - see your last submissions and their status',
      '/cancel - cancel a pending submission',
      '/help - show this list',
    ].join('\n')
  ));

  bot.command('feedback', async ctx => {
    db.upsertUser(ctx.from);
    const text = ctx.message.text.replace(/^\/feedback\s*/i, '').trim();
    if (text) return submit(ctx, text);
    pending.set(ctx.from.id, Date.now() + config.pendingTtlSeconds * 1000);
    return ctx.reply(`Send your feedback as the next message within ${Math.round(config.pendingTtlSeconds / 60)} minutes, or use /cancel.`);
  });

  bot.command('cancel', ctx => {
    pending.delete(ctx.from.id);
    return ctx.reply('Cancelled.');
  });

  bot.command('myfeedback', async ctx => {
    const items = db.listUserFeedback(ctx.from.id, 5);
    if (!items.length) return ctx.reply('You have not sent any feedback yet. Use /feedback to send some.');
    const lines = items.map(item => `#${item.id} · ${formatStatus(item)} · ${item.created_at.slice(0, 10)}${item.reply_text ? '\n   reply: ' + item.reply_text : ''}`);
    return ctx.reply(`Your last ${items.length} submission(s):\n${lines.join('\n')}`);
  });

  bot.on('text', async (ctx, next) => {
    const hadPrompt = isPending(ctx.from.id);
    if (!hadPrompt || ctx.message.text.startsWith('/')) return next();
    const accepted = await submit(ctx, ctx.message.text);
    if (accepted) pending.delete(ctx.from.id);
    return true;
  });
}

module.exports = { register };
