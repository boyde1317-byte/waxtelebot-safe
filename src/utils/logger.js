const config = require('../config');
const util = require('util');

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = levels[String(config.logLevel).toLowerCase()] ?? levels.info;

function emit(level, ...args) {
  if (levels[level] < threshold) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${util.format(...args)}\n`;
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(line);
}

module.exports = {
  debug: (...args) => emit('debug', ...args),
  info: (...args) => emit('info', ...args),
  warn: (...args) => emit('warn', ...args),
  error: (...args) => emit('error', ...args),
};
