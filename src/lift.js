// Imports a WhatsApp Web session lifted from a browser into a fresh account.
// The bot never pairs: creds arrive with `registered: true`, so session.connect()
// skips requestPairingCode() and goes straight to the handshake.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../utils/logger');
const accounts = require('./accounts');

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BYTES = 256 * 1024;

function bytes(value, len) {
  if (typeof value !== 'string' || !B64.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return len && buf.length !== len ? null : buf;
}

function keypair(value) {
  if (!value || !bytes(value.private, 32) || !bytes(value.public, 32)) return null;
  return { private: value.private, public: value.public };
}

// Everything here is a hard requirement for a handshake. Returns a list of
// what is missing so the admin sees the real reason instead of a socket timeout.
function validate(payload) {
  const problems = [];
  if (!payload || typeof payload !== 'object') return ['payload is not an object'];

  const candidates = (Array.isArray(payload.noiseCandidates) ? payload.noiseCandidates : [])
    .map(keypair).filter(Boolean);
  const noise = keypair(payload.noiseKey) || candidates[0];
  if (!noise) problems.push('noiseKey missing or not 32-byte base64');

  if (!keypair(payload.signedIdentityKey)) problems.push('signedIdentityKey missing or not 32-byte base64');
  if (!bytes(payload.advSecretKey, 32)) problems.push('advSecretKey missing or not 32-byte base64');
  if (!Number.isSafeInteger(payload.registrationId) || payload.registrationId <= 0) problems.push('registrationId invalid');

  const id = String(payload.me?.id || '');
  if (!/@(s\.whatsapp\.net|c\.us)$/.test(id)) problems.push('me.id is not a WhatsApp jid');

  const account = payload.account || {};
  for (const field of ['details', 'accountSignatureKey', 'accountSignature', 'deviceSignature']) {
    if (!bytes(account[field])) problems.push(`account.${field} missing or not base64`);
  }
  return problems;
}

function platformFor(ua = '') {
  if (/Firefox/i.test(ua)) return 'firefox';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome/i.test(ua)) return 'chrome';
  if (/Safari/i.test(ua)) return 'safari';
  return 'chrome';
}

// A signed prekey is 32 bytes signed with the identity key. Builds drift, so the
// extractor may miss it; derive one rather than hand Baileys an undefined field.
async function backfillSignedPreKey(creds, b) {
  if (creds.signedPreKey?.signature) return 'from-source';
  try {
    if (typeof b.generateKeyPair !== 'function' || !b.Curve?.sign) return 'unavailable';
    const pair = b.generateKeyPair();
    const signature = await b.Curve.sign(bytes(creds.signedIdentityKey.private, 32), pair.public);
    creds.signedPreKey = {
      keyId: 1,
      private: Buffer.from(pair.private).toString('base64'),
      public: Buffer.from(pair.public).toString('base64'),
      signature: Buffer.from(signature).toString('base64'),
    };
    return 'derived';
  } catch (error) {
    log.warn('Signed prekey backfill failed: %s', error.message);
    return 'unavailable';
  }
}

function toCreds(payload) {
  const account = payload.account || {};
  return {
    registrationId: payload.registrationId,
    noiseKey: keypair(payload.noiseKey) || keypair(payload.noiseCandidates?.[0]),
    signedIdentityKey: keypair(payload.signedIdentityKey),
    signedPreKey: payload.signedPreKey?.signature ? {
      keyId: Number(payload.signedPreKey.keyId) || 1,
      private: payload.signedPreKey.private,
      public: payload.signedPreKey.public,
      signature: payload.signedPreKey.signature,
    } : null,
    advSecretKey: payload.advSecretKey,
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSettings: { unarchiveChats: false },
    me: { id: payload.me.id.replace('@c.us', '@s.whatsapp.net'), name: payload.me.name || '' },
    platform: platformFor(payload.meta?.ua),
    registered: true,
    account: {
      details: account.details,
      accountSignatureKey: account.accountSignatureKey,
      accountSignature: account.accountSignature,
      deviceSignature: account.deviceSignature,
    },
  };
}

function writeCreds(authDir, creds) {
  fs.mkdirSync(authDir, { recursive: true });
  // A failed handshake is a 401, and session.js wipes the folder on 401.
  // Keep a copy so a bad import can be retried instead of re-stolen.
  const existing = path.join(authDir, 'creds.json');
  if (fs.existsSync(existing)) {
    fs.copyFileSync(existing, path.join(authDir, `creds.${Date.now()}.bak.json`));
  }
  const tmp = path.join(authDir, '.creds.tmp');
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2));
  fs.renameSync(tmp, path.join(authDir, 'creds.json'));
}

async function importLifted(payload, { label = null, notify = null } = {}) {
  if (!config.waEnabled) throw new Error('WhatsApp is disabled by configuration.');

  const problems = validate(payload);
  if (problems.length) {
    const error = new Error(problems.join('; '));
    error.problems = problems;
    throw error;
  }

  const b = await import('baileys');
  const creds = toCreds(payload);
  const preKeySource = await backfillSignedPreKey(creds, b);

  const session = accounts.create(label || `Lifted ${creds.me.id.split('@')[0]}`);
  const { authDir } = session.status();
  writeCreds(authDir, creds);

  if (notify) {
    const off = session.subscribe((type, snap) => {
      if (type === 'open') {
        off();
        notify(`Imported session is live as +${snap.number || '?'}.`);
      } else if (type === 'pairingFailed' || type === 'reconnectFailed') {
        off();
        notify(`Import failed for ${snap.label}: ${snap.lastError || type}`);
      }
    });
  }

  const status = await session.connect(); // no phone: creds.registered is true
  return {
    accountId: session.id,
    label: session.snapshot.label,
    number: creds.me.id.split('@')[0],
    preKeySource,
    alreadyPaired: !status?.code,
  };
}

module.exports = { importLifted, validate, MAX_BYTES };
