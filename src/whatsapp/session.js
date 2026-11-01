// One Baileys socket, owned by the bot. Pairing is by phone number, not QR.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const log = require('../utils/logger');
const { toJid, toPhoneDigits, bareJid } = require('./jid');

let baileys = null;
async function loadBaileys() {
  if (!baileys) baileys = await import('baileys'); // ESM-only package, loaded lazily
  return baileys;
}

const snapshot = {
  state: 'idle', // idle | pairing | connecting | open | closed
  connected: false,
  number: null,
  since: null,
  lastError: null,
};

let sock = null;
let reconnectTimer = null;
let attempts = 0;
let stopping = false;
let everConnected = false;

const subscribers = new Set();
function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
function broadcast(type, payload = {}) {
  for (const fn of subscribers) {
    try {
      fn(type, { ...snapshot, ...payload });
    } catch (error) {
      log.warn('WhatsApp subscriber failed: %s', error.message);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function status() {
  return { ...snapshot, hasCreds: hasCreds(), authDir: config.waAuthDir };
}

function hasCreds() {
  try {
    return fs.existsSync(path.join(config.waAuthDir, 'creds.json'));
  } catch {
    return false;
  }
}

function wipeAuth() {
  try {
    fs.rmSync(config.waAuthDir, { recursive: true, force: true });
  } catch (error) {
    log.warn('Could not clear WhatsApp auth: %s', error.message);
  }
}

// --- sending guard rails ---------------------------------------------------
const sendTimes = [];

function reserveSendSlot() {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  while (sendTimes.length && sendTimes[0] < cutoff) sendTimes.shift();
  if (sendTimes.length >= config.waSendHourlyCap) {
    throw new Error(`Hourly send cap reached (${config.waSendHourlyCap}). Try again later.`);
  }
  const last = sendTimes[sendTimes.length - 1] || 0;
  if (now - last < config.waSendMinIntervalMs) {
    throw new Error('Slow down: wait a moment between messages.');
  }
  sendTimes.push(now);
}

// --- connection lifecycle --------------------------------------------------
async function connect({ phone = null } = {}) {
  if (!config.waEnabled) throw new Error('WhatsApp is disabled by configuration.');
  if (sock && snapshot.connected) return snapshot;

  stopping = false;
  const b = await loadBaileys();
  fs.mkdirSync(config.waAuthDir, { recursive: true });

  const { state: authState, saveCreds } = await b.useMultiFileAuthState(config.waAuthDir);
  const versionInfo = await b.fetchLatestBaileysVersion().catch(() => ({}));

  everConnected = false;
  snapshot.state = authState.creds.registered ? 'connecting' : 'pairing';
  snapshot.lastError = null;

  sock = b.makeWASocket({
    ...(versionInfo.version ? { version: versionInfo.version } : {}),
    auth: authState,
    browser: b.Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', update => handleConnectionUpdate(b, update));

  if (authState.creds.registered) return snapshot;

  if (!phone) {
    throw new Error('A phone number is required the first time you pair.');
  }
  const digits = toPhoneDigits(phone, config.waDefaultCountry);
  if (!digits) throw new Error('That does not look like a phone number. Include the country code, e.g. +233241234567.');

  const code = await requestPairingCode(digits);
  snapshot.state = 'pairing';
  snapshot.number = digits;
  broadcast('pairing', { code });
  return { ...snapshot, code };
}

async function requestPairingCode(digits) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const code = await sock.requestPairingCode(digits);
      if (code) return code;
    } catch (error) {
      lastError = error;
    }
    await sleep(1500);
  }
  throw lastError || new Error('WhatsApp did not return a pairing code.');
}

function handleConnectionUpdate(b, update) {
  const { connection, lastDisconnect } = update;

  if (connection === 'open') {
    everConnected = true;
    snapshot.state = 'open';
    snapshot.connected = true;
    snapshot.since = new Date().toISOString();
    snapshot.lastError = null;
    attempts = 0;
    if (sock?.user?.id) snapshot.number = String(sock.user.id).split(':')[0].split('@')[0];
    log.info('WhatsApp connected as %s', snapshot.number || '(unknown)');
    broadcast('open');
    return;
  }

  if (connection !== 'close') return;

  const statusCode = lastDisconnect?.error?.output?.statusCode;
  const reason = lastDisconnect?.error?.message || 'connection closed';
  snapshot.connected = false;
  snapshot.state = 'closed';
  snapshot.lastError = `${reason}${statusCode ? ` (${statusCode})` : ''}`;
  sock = null;

  const loggedOut = statusCode === b.DisconnectReason.loggedOut || statusCode === 401;
  if (loggedOut) {
    const failedDuringPairing = !everConnected;
    snapshot.state = 'idle';
    snapshot.number = null;
    snapshot.since = null;
    wipeAuth();
    log.warn(failedDuringPairing
      ? 'Pairing did not complete: %s' : 'WhatsApp logged us out; session cleared.', snapshot.lastError);
    broadcast(failedDuringPairing ? 'pairingFailed' : 'loggedOut', { reason: snapshot.lastError });
    return;
  }

  log.warn('WhatsApp connection closed: %s', snapshot.lastError);
  broadcast('close', { reason: snapshot.lastError });

  if (!stopping) scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer || stopping) return;
  if (attempts >= 6) {
    log.warn('WhatsApp reconnect attempts exhausted.');
    broadcast('reconnectFailed');
    return;
  }
  const delayMs = Math.min(60000, 2000 * 2 ** attempts);
  attempts += 1;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connect();
    } catch (error) {
      log.warn('WhatsApp reconnect failed: %s', error.message);
      scheduleReconnect();
    }
  }, delayMs);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

// Called on boot: reconnects an existing session without a phone number.
async function restore() {
  if (!config.waEnabled || !hasCreds()) return status();
  try {
    await connect();
  } catch (error) {
    snapshot.lastError = error.message;
    log.warn('Could not restore WhatsApp session: %s', error.message);
  }
  return status();
}

async function stop() {
  stopping = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try {
      await sock.end(undefined);
    } catch (error) {
      log.debug('Socket end failed: %s', error.message);
    }
  }
  sock = null;
  snapshot.connected = false;
  snapshot.state = 'idle';
}

async function logout() {
  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      log.warn('Logout failed: %s', error.message);
    }
  }
  await stop();
  wipeAuth();
  snapshot.number = null;
  snapshot.since = null;
  snapshot.lastError = null;
  broadcast('loggedOut', { reason: 'unpaired from Telegram' });
  return status();
}

// --- messaging -------------------------------------------------------------
async function sendText({ rawJid, text, adminId = null }) {
  if (!config.waEnabled) throw new Error('WhatsApp is disabled by configuration.');
  if (!sock || !snapshot.connected) throw new Error('WhatsApp is not connected. Pair it first with /pair.');

  const target = toJid(rawJid, config.waDefaultCountry);
  if (!target) throw new Error('That destination is not a valid number or group id.');
  const body = String(text ?? '').trim();
  if (!body) throw new Error('The message is empty.');

  reserveSendSlot();
  try {
    const result = await sock.sendMessage(target, { text: body });
    db.logSend({ adminId, jid: target, body, status: 'sent' });
    return { id: result?.key?.id || null, jid: target };
  } catch (error) {
    db.logSend({ adminId, jid: target, body, status: 'failed', error: error.message });
    throw error;
  }
}

async function listGroups(limit = config.waGroupListLimit) {
  if (!sock || !snapshot.connected) throw new Error('WhatsApp is not connected. Pair it first with /pair.');
  const all = await sock.groupFetchAllParticipating();
  return Object.values(all || {})
    .map(group => ({
      jid: bareJid(group.id),
      subject: group.subject || '(no name)',
      participants: Array.isArray(group.participants) ? group.participants.length : 0,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject))
    .slice(0, limit);
}

async function checkNumber(rawNumber) {
  if (!sock || !snapshot.connected) throw new Error('WhatsApp is not connected. Pair it first with /pair.');
  const digits = toPhoneDigits(rawNumber, config.waDefaultCountry);
  if (!digits) throw new Error('That does not look like a phone number.');
  const results = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
  const hit = Array.isArray(results) ? results[0] : null;
  return { digits, exists: Boolean(hit?.exists), jid: hit?.jid ? bareJid(hit.jid) : `${digits}@s.whatsapp.net` };
}

module.exports = {
  subscribe,
  status,
  restore,
  connect,
  stop,
  logout,
  sendText,
  listGroups,
  checkNumber,
  hasCreds,
};
