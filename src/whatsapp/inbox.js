// Recent inbound media, so pictures received on WhatsApp can be saved from Telegram.
const config = require('../config');
const log = require('../utils/logger');
const session = require('./session');
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

function record(raw) {
  const type = mediaTypeOf(raw?.message);
  const text = textOf(raw?.message);
  const kind = type ? 'media' : text ? 'text' : null;
  if (!kind || !raw?.key?.id || !raw.key.remoteJid) return;
  const id = raw.key.id;
  entries.set(id, {
    kind,
    text,
    id,
    jid: raw.key.remoteJid,
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
  while (order.length > config.waInboxLimit) {
    const dropped = order.shift();
    entries.delete(dropped);
  }
}

function list({ jid = null, kind = null, limit = 8 } = {}) {
  const out = [];
  for (let i = order.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = entries.get(order[i]);
    if (!entry) continue;
    if (jid && entry.jid !== jid) continue;
    if (kind && entry.kind !== kind) continue;
    out.push(entry);
  }
  return out;
}

// Newest indexed text from a chat, so it can be copied from Telegram.
function lastText(jid) {
  const [entry] = list({ jid, kind: 'text', limit: 1 });
  return entry ? { text: entry.text, sender: entry.sender, at: entry.at } : null;
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
  session.requireSocket();
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

module.exports = { attach, record, list, download, label, lastText, clear: () => { entries.clear(); order.length = 0; } };
