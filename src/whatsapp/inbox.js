// Recent inbound media, so pictures received on WhatsApp can be saved from Telegram.
const config = require('../config');
const log = require('../utils/logger');
const { jidLabel } = require('./jid');

const MEDIA_TYPES = [
  'imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage',
  'ptvMessage', 'audioMessage',
];

const entries = new Map(); // message id -> entry
const order = []; // message ids, oldest first

function mediaTypeOf(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return mediaTypeOf(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return mediaTypeOf(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return mediaTypeOf(message.viewOnceMessageV2.message);
  return MEDIA_TYPES.find(type => message[type]) || null;
}

function textOf(message) {
  const inner = innerMessage(message);
  if (!inner) return null;
  if (typeof inner.conversation === 'string' && inner.conversation) return inner.conversation;
  if (typeof inner.extendedTextMessage?.text === 'string') return inner.extendedTextMessage.text;
  for (const type of MEDIA_TYPES) {
    const caption = inner[type]?.caption;
    if (typeof caption === 'string' && caption) return caption;
  }
  return null;
}

function innerMessage(message) {
  if (!message) return null;
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2']) {
    if (message[wrapper]?.message) return innerMessage(message[wrapper].message);
  }
  return message;
}

function record(raw, account = null) {
  const type = mediaTypeOf(raw?.message);
  const text = textOf(raw?.message);
  const kind = type ? 'media' : text ? 'text' : null;
  if (!kind || !raw?.key?.id || !raw.key.remoteJid) return;
  const id = raw.key.id;
  const inner = innerMessage(raw.message);
  const isGroup = String(raw.key.remoteJid).endsWith('@g.us');
  entries.set(id, {
    kind,
    text,
    id,
    inner,
    accountId: account?.id ?? null,
    accountLabel: account?.label || null,
    jid: raw.key.remoteJid,
    isGroup,
    // Who sent it, in the shape a spam report needs.
    fromJid: isGroup ? (raw.key.participant || null) : (raw.key.fromMe ? null : raw.key.remoteJid),
    participant: raw.key.participant || null,
    mediaType: type ? type.replace('Message', '').toLowerCase() : null,
    type,
    fromMe: Boolean(raw.key.fromMe),
    at: Number(raw.messageTimestamp || 0) * 1000 || Date.now(),
    sender: raw.pushName || jidLabel(raw.key.participant || raw.key.remoteJid),
    message: raw,
    mime: innerMessage(raw.message)?.[type]?.mimetype || '',
    fileName: innerMessage(raw.message)?.[type]?.fileName || '',
    caption: innerMessage(raw.message)?.[type]?.caption || '',
  });
  order.push(id);

  // The buffer is capped per account, not overall: one chatty number must not
  // push another account's recent media out of the list.
  const limit = config.waInboxLimit;
  const accountId = account?.id ?? null;
  let kept = 0;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const held = entries.get(order[index]);
    if (!held || (held.accountId ?? null) !== accountId) continue;
    kept += 1;
    if (kept > limit) {
      entries.delete(order[index]);
      order.splice(index, 1);
    }
  }

  // Backstop for a roster far larger than the configured cap.
  const ceiling = limit * Math.max(8, config.waMaxAccounts);
  while (order.length > ceiling) {
    entries.delete(order.shift());
  }
}

function list({ accountId = null, jid = null, kind = null, limit = 8 } = {}) {
  const out = [];
  for (let i = order.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = entries.get(order[i]);
    if (!entry) continue;
    if (accountId !== null && entry.accountId !== accountId) continue;
    if (jid && entry.jid !== jid) continue;
    if (kind && entry.kind !== kind) continue;
    out.push(entry);
  }
  return out;
}

// Newest indexed text from a chat, so it can be copied from Telegram.
function lastText(jid, accountId = null) {
  const [entry] = list({ accountId, jid, kind: 'text', limit: 1 });
  return entry ? { text: entry.text, sender: entry.sender, at: entry.at } : null;
}

function get(id) {
  return entries.get(id) || null;
}

function label(entry) {
  const kind = entry.kind === 'text'
    ? 'text'
    : entry.type.replace('Message', '').replace('ptv', 'video note');
  const from = entry.fromMe ? 'you' : entry.sender;
  return `${kind} · ${from} · ${new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

async function download(id) {
  const entry = entries.get(id);
  if (!entry) throw new Error('That media is no longer in the recent list.');
  // Lazy require: the account registry imports this module.
  const accounts = require('./accounts');
  const account = entry.accountId === null ? null : accounts.get(entry.accountId);
  if (!account) throw new Error('That media belongs to an account that is no longer linked.');
  account.requireSocket();
  const { downloadMediaMessage } = await import('baileys');
  const buffer = await downloadMediaMessage(entry.message, 'buffer', {}, {
    logger: log,
    reuploadRequest: undefined,
  });
  if (!buffer || !buffer.length) throw new Error('WhatsApp returned an empty file.');
  return { ...entry, buffer };
}

// Wires the session's incoming hook; called once from bot.js.
function attach() {
  session.setIncomingHandler(record);
}

module.exports = { attach, record, list, get, download, label, lastText, clear: () => { entries.clear(); order.length = 0; } };
