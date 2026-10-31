const config = require('../config');
const db = require('../db');

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
  return `#${item.id} — ${who}\n${item.text}\n${item.created_at}`;
}

function register(bot) {
  bot.command('inbox', async ctx => {
    if (!requireAdmin(ctx)) return;
    const items = db.listOpenFeedback(20);
    if (!items.length) return ctx.reply('Inbox is empty.');
    await ctx.reply(items.map(formatItem).join('\n\n'));
  });

  bot.command('resolve', async ctx => {
    if (!requireAdmin(ctx)) return;
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isSafeInteger(id) || id < 1) return ctx.reply('Usage: /resolve <feedback_id>');
    await ctx.reply(db.resolveFeedback(id) ? `Feedback #${id} resolved.` : 'Feedback not found or already resolved.');
  });

  bot.command('adminstats', async ctx => {
    if (!requireAdmin(ctx)) return;
    const counts = db.feedbackCounts();
    await ctx.reply(`Feedback total: ${counts.total}\nOpen: ${counts.open}`);
  });
}

module.exports = { register, isAdmin };
