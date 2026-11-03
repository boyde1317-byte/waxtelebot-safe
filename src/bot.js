const { Telegraf } = require('telegraf');
const config = require('./config');
const db = require('./db');
const log = require('./utils/logger');
const whatsappHandler = require('./handlers/whatsapp');
const startHandler = require('./handlers/start');
const adminHandler = require('./handlers/admin');
const accounts = require('./whatsapp/accounts');

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
// WhatsApp controls register first so their staged text input wins over the feedback prompt.
whatsappHandler.register(bot);
startHandler.register(bot);
adminHandler.register(bot);
bot.on('message', ctx => ctx.reply('Use /help to see available commands.'));

// Telegram answering 502/504 is their outage, not a bad token. Exiting on it
// turns a blip into a crash loop, so keep retrying with backoff instead.
async function launchWithRetry() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await bot.launch({ dropPendingUpdates: false });
      return;
    } catch (error) {
      const delay = Math.min(60000, 2000 * Math.min(attempt, 30));
      log.error('Telegram launch failed (%s); retrying in %ss', error.message, Math.round(delay / 1000));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  log.info('Starting feedback bot; admins: %s', config.adminIds.join(', ') || '(none)');
  await launchWithRetry();
  log.info('Bot is live.');
  if (config.waEnabled) {
    accounts.init();
    const linked = accounts.list().length;
    if (linked >= 10) {
      log.info('WhatsApp fleet of %d: each live session holds its own socket and key store, roughly 40-80MB each.', linked);
    }
    accounts.restoreAll().then(rows => {
      const connected = rows.filter(row => row.status.connected).map(row => `+${row.status.number || '?'}`);
      log.info('WhatsApp: %d account(s) linked, %d connected%s',
        rows.length, connected.length, connected.length ? ` (${connected.join(', ')})` : '');
    });
  }
}

function shutdown(signal) {
  log.info('%s received; shutting down', signal);
  bot.stop(signal);
  accounts.stopAll().catch(() => {}).finally(() => db.db.close());
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => {
  log.error('Unhandled rejection: %s', (error && error.stack) || error);
});
main().catch(error => {
  log.error('Fatal: %s', error.stack || error.message);
  process.exit(1);
});
