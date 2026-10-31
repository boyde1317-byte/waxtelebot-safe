const db = require('../db');
const pending = new Map();

function register(bot) {
  bot.start(async ctx => {
    db.upsertUser(ctx.from);
    await ctx.reply('Welcome. Use /feedback to send a message to the support team, or /help for commands.');
  });

  bot.command('help', ctx => ctx.reply('/start - subscribe\n/feedback - send feedback\n/cancel - cancel a pending submission'));

  bot.command('feedback', async ctx => {
    db.upsertUser(ctx.from);
    const text = ctx.message.text.replace(/^\/feedback\s*/i, '').trim();
    if (text) {
      const item = db.createFeedback(ctx.from.id, text);
      return ctx.reply(`Feedback #${item.id} received. Thank you.`);
    }
    pending.set(ctx.from.id, Date.now());
    return ctx.reply('Send your feedback as the next message, or use /cancel.');
  });

  bot.command('cancel', ctx => {
    pending.delete(ctx.from.id);
    return ctx.reply('Cancelled.');
  });

  bot.on('text', async (ctx, next) => {
    if (!pending.has(ctx.from.id) || ctx.message.text.startsWith('/')) return next();
    pending.delete(ctx.from.id);
    db.upsertUser(ctx.from);
    const item = db.createFeedback(ctx.from.id, ctx.message.text.trim());
    return ctx.reply(`Feedback #${item.id} received. Thank you.`);
  });
}

module.exports = { register };
