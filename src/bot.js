const { Telegraf } = require('telegraf');
const config = require('./config');
const db = require('./db');
const log = require('./utils/logger');
const startHandler = require('./handlers/start');
const adminHandler = require('./handlers/admin');

if (!config.botToken) throw new Error('Missing BOT_TOKEN. Copy .env.example to .env and set BOT_TOKEN.');

const bot = new Telegraf(config.botToken);
bot.use(async (ctx, next) => {
  if (ctx.from) db.upsertUser(ctx.from);
  try {
    await next();
  } catch (error) {
    log.error('Update failed: %s', error.stack || error.message);
    await ctx.reply('The bot could not process that request.').catch(() => {});
  }
});
startHandler.register(bot);
adminHandler.register(bot);
bot.on('message', ctx => ctx.reply('Use /help to see available commands.'));

async function main() {
  log.info('Starting feedback bot; admins: %s', config.adminIds.join(', ') || '(none)');
  await bot.launch({ dropPendingUpdates: false });
  log.info('Bot is live.');
}

function shutdown(signal) {
  log.info('%s received; shutting down', signal);
  bot.stop(signal);
  db.db.close();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
main().catch(error => {
  log.error('Fatal: %s', error.stack || error.message);
  process.exit(1);
});
