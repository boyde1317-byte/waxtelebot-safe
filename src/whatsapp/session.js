// A Baileys socket per linked WhatsApp account. Pairing is by phone number, not QR.
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One session per linked account. Nothing here is module state, so several
// accounts can run in the same process without touching each other.
function createSession({ id, label, authDir }) {
  const snapshot = {
    id,
    label: label || `Account ${id}`,
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
  let incomingHandler = null;
  const sendTimes = [];

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

  function hasCreds() {
    try {
      return fs.existsSync(path.join(authDir, 'creds.json'));
    } catch {
      return false;
    }
  }

  function status() {
    return { ...snapshot, hasCreds: hasCreds(), authDir };
  }

  function wipeAuth() {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
    } catch (error) {
      log.warn('Could not clear WhatsApp auth for %s: %s', snapshot.label, error.message);
    }
  }

  // Throws unless this account has a live socket.
  function requireSocket() {
    if (!config.waEnabled) throw new Error('WhatsApp is disabled by configuration.');
    if (!sock || !snapshot.connected) {
      throw new Error(`${snapshot.label} is not connected. Pair it first or switch account.`);
    }
    return sock;
  }

  // --- sending guard rails (per account, so one busy account cannot starve another)
  function reserveSendSlot() {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    while (sendTimes.length && sendTimes[0] < cutoff) sendTimes.shift();
    if (sendTimes.length >= config.waSendHourlyCap) {
      throw new Error(`Hourly send cap reached for ${snapshot.label} (${config.waSendHourlyCap}). Try again later.`);
    }
    const last = sendTimes[sendTimes.length - 1] || 0;
    if (now - last < config.waSendMinIntervalMs) {
      throw new Error('Slow down: wait a moment between messages.');
    }
    sendTimes.push(now);
  }

  // --- connection lifecycle ------------------------------------------------
  async function connect({ phone = null } = {}) {
    if (!config.waEnabled) throw new Error('WhatsApp is disabled by configuration.');
    if (sock && snapshot.connected) return status();

    stopping = false;
    const b = await loadBaileys();
    fs.mkdirSync(authDir, { recursive: true });

    const { state: authState, saveCreds } = await b.useMultiFileAuthState(authDir);
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
    sock.ev.on('messages.upsert', event => {
      if (!incomingHandler) return;
      for (const message of event?.messages || []) {
        try {
          incomingHandler(message, status());
        } catch (error) {
          log.debug('Incoming message handler failed: %s', error.message);
        }
      }
    });

    if (authState.creds.registered) return status();

    if (!phone) {
      throw new Error('A phone number is required the first time you pair.');
    }
    const digits = toPhoneDigits(phone, config.waDefaultCountry);
    if (!digits) throw new Error('That does not look like a phone number. Include the country code, e.g. +233241234567.');

    const code = await requestPairingCode(digits);
    snapshot.state = 'pairing';
    snapshot.number = digits;
    db.updateAccount(id, { phone: digits });
    broadcast('pairing', { code });
    return { ...status(), code };
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
      db.updateAccount(id, { phone: snapshot.number, jid: sock?.user?.id || null });
      log.info('WhatsApp %s connected as %s', snapshot.label, snapshot.number || '(unknown)');
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
      log.warn('%s %s', snapshot.label, failedDuringPairing
        ? `pairing did not complete: ${snapshot.lastError}`
        : 'was logged out; session cleared');
      broadcast(failedDuringPairing ? 'pairingFailed' : 'loggedOut', { reason: snapshot.lastError });
      return;
    }

    log.warn('%s connection closed: %s', snapshot.label, snapshot.lastError);
    broadcast('close', { reason: snapshot.lastError });

    if (!stopping) scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer || stopping) return;
    if (attempts >= 6) {
      log.warn('%s reconnect attempts exhausted.', snapshot.label);
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
        log.warn('%s reconnect failed: %s', snapshot.label, error.message);
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
      log.warn('Could not restore %s: %s', snapshot.label, error.message);
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
        log.debug('Socket end failed for %s: %s', snapshot.label, error.message);
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
        log.warn('Logout failed for %s: %s', snapshot.label, error.message);
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

  // --- messaging ----------------------------------------------------------
  async function sendText({ rawJid, text, adminId = null }) {
    const live = requireSocket();
    const target = toJid(rawJid, config.waDefaultCountry);
    if (!target) throw new Error('That destination is not a valid number or group id.');
    const body = String(text ?? '').trim();
    if (!body) throw new Error('The message is empty.');

    reserveSendSlot();
    try {
      const result = await live.sendMessage(target, { text: body });
      db.logSend({ adminId, accountId: id, jid: target, body, status: 'sent' });
      return { id: result?.key?.id || null, jid: target, account: snapshot.label };
    } catch (error) {
      db.logSend({ adminId, accountId: id, jid: target, body, status: 'failed', error: error.message });
      throw error;
    }
  }

  async function listGroups(limit = config.waGroupListLimit) {
    const live = requireSocket();
    const all = await live.groupFetchAllParticipating();
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
    const live = requireSocket();
    const digits = toPhoneDigits(rawNumber, config.waDefaultCountry);
    if (!digits) throw new Error('That does not look like a phone number.');
    const results = await live.onWhatsApp(`${digits}@s.whatsapp.net`);
    const hit = Array.isArray(results) ? results[0] : null;
    return { digits, exists: Boolean(hit?.exists), jid: hit?.jid ? bareJid(hit.jid) : `${digits}@s.whatsapp.net` };
  }

  // Test-only: lets the offline suite assert patches without a live socket.
  function __setSocketForTests(fake) {
    sock = fake || null;
    snapshot.connected = Boolean(fake) && snapshot.state !== 'pairing';
    if (fake) snapshot.state = 'open';
    if (!fake) snapshot.state = 'idle';
  }

  // Registered by the media inbox so the session stays free of those imports.
  function setIncomingHandler(fn) {
    incomingHandler = fn;
  }

  return {
    id,
    snapshot,
    subscribe,
    requireSocket,
    __setSocketForTests,
    setIncomingHandler,
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
}

module.exports = { createSession };
