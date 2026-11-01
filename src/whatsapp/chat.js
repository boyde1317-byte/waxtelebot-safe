// Chat-level actions: the things WhatsApp's in-chat menu does, driven from Telegram.
const config = require('../config');
const session = require('./session');
const { toJid, jidLabel } = require('./jid');

function target(rawJid, defaultCountry) {
  const jid = toJid(rawJid, defaultCountry);
  if (!jid) throw new Error('That is not a valid number or group id.');
  return jid;
}

// WhatsApp stores the mute end as a unix timestamp in seconds; null lifts it.
function muteEnd(durationMs) {
  if (durationMs === null) return null;
  const seconds = Math.floor((Date.now() + durationMs) / 1000);
  return seconds;
}

async function setMute(rawJid, durationMs, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().chatModify({ mute: muteEnd(durationMs) }, jid);
  return jid;
}

async function setPin(rawJid, pinned, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().chatModify({ pin: Boolean(pinned) }, jid);
  return jid;
}

async function setArchive(rawJid, archived, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().chatModify({ archive: Boolean(archived), lastMessages: [] }, jid);
  return jid;
}

async function markRead(rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().chatModify({ markRead: true, lastMessages: [] }, jid);
  return jid;
}

async function clearChat(rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().chatModify({ clear: true, lastMessages: [] }, jid);
  return jid;
}

async function deleteChat(rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().chatModify({ delete: true, lastMessages: [] }, jid);
  return jid;
}

async function setBlocked(rawJid, blocked, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().updateBlockStatus(jid, blocked ? 'block' : 'unblock');
  return jid;
}

// Reporting is undocumented. The only detailed wire format available comes from
// whatsapp-rust (the core Baileys 7 embeds through whatsapp-rust-bridge): the IQ
// reports a *message*, carries spam_flow on <spam_list>, and answers with report_id.
// Baileys itself exposes nothing for this and upstream calls it unsupported.

function reportIdFrom(result) {
  const children = Array.isArray(result?.content) ? result.content : [];
  for (const node of children) {
    if (node?.tag !== 'report_id') continue;
    if (Buffer.isBuffer(node.content)) return node.content.toString('utf8');
    if (typeof node.content === 'string') return node.content;
    const first = Array.isArray(node.content) ? node.content[0]?.content : null;
    return first ? String(first) : null;
  }
  return null;
}

// Builds the spam IQ for one indexed message. Exported so the shape can be tested.
function buildSpamIq(entry, { flow, subject = null } = {}) {
  const { proto } = require('baileys');
  const spamFlow = flow || (entry.isGroup ? 'GroupInfoReport' : 'MessageMenu');
  const listAttrs = { spam_flow: spamFlow };
  if (entry.isGroup) {
    listAttrs.jid = entry.jid;
    if (subject) listAttrs.subject = subject;
  }

  const messageAttrs = { id: entry.id, t: String(Math.floor(entry.at / 1000)) };
  if (entry.fromJid) messageAttrs.from = entry.fromJid;
  if (entry.isGroup && entry.participant) messageAttrs.participant = entry.participant;

  const messageChildren = [];
  if (entry.inner) {
    const rawAttrs = { v: '3' };
    if (entry.mediaType) rawAttrs.mediatype = entry.mediaType;
    const bytes = proto.Message.encode(proto.Message.fromObject(entry.inner)).finish();
    messageChildren.push({ tag: 'raw', attrs: rawAttrs, content: Buffer.from(bytes) });
  }

  return {
    tag: 'iq',
    attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' },
    content: [{
      tag: 'spam_list',
      attrs: listAttrs,
      content: [{ tag: 'message', attrs: messageAttrs, content: messageChildren }],
    }],
  };
}

async function reportMessage(entry, { block = false, flow = null, subject = null } = {}) {
  const sock = session.requireSocket();
  if (!entry?.id) throw new Error('There is no message to report.');

  const node = buildSpamIq(entry, { flow, subject });
  // query() resolves to undefined when the server never answers, so the return
  // value is the only evidence we have.
  const result = await sock.query(node, config.waQueryTimeoutMs);
  const reportId = reportIdFrom(result);
  const status = result === undefined ? 'unanswered' : reportId ? 'confirmed' : 'unconfirmed';

  let blocked = false;
  if (block) {
    await sock.updateBlockStatus(entry.jid, 'block');
    blocked = true;
  }
  return { jid: entry.jid, status, reportId, blocked, flow: node.content[0].attrs.spam_flow };
}

async function contactInfo(rawJid, defaultCountry) {
  const sock = session.requireSocket();
  const jid = target(rawJid, defaultCountry);
  const info = { jid, label: jidLabel(jid), exists: null, about: null, picture: null };

  const presence = await sock.onWhatsApp(jid).catch(() => null);
  if (Array.isArray(presence) && presence[0]) info.exists = Boolean(presence[0].exists);

  const statuses = await sock.fetchStatus(jid).catch(() => null);
  const first = Array.isArray(statuses) ? statuses[0] : null;
  if (first?.status?.setAt || first?.status?.text) {
    info.about = first.status?.text || null;
  }

  info.picture = await sock.profilePictureUrl(jid, 'preview').catch(() => null);
  return info;
}

async function groupInvite(rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  const code = await session.requireSocket().groupInviteCode(jid);
  if (!code) throw new Error('WhatsApp did not return an invite link for that group.');
  return { jid, link: `https://chat.whatsapp.com/${code}` };
}

async function groupMembers(rawJid, limit = 30, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  const meta = await session.requireSocket().groupMetadata(jid);
  const members = (meta?.participants || []).map(p => ({
    jid: jidLabel(p.id),
    admin: p.admin === 'admin' || p.admin === 'superadmin',
  }));
  return {
    jid,
    subject: meta?.subject || '(no name)',
    total: members.length,
    members: members.slice(0, limit),
  };
}

async function leaveGroup(rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await session.requireSocket().groupLeave(jid);
  return jid;
}

module.exports = {
  setMute, setPin, setArchive, markRead, clearChat, deleteChat, setBlocked,
  reportMessage, buildSpamIq, reportIdFrom,
  contactInfo, groupInvite, groupMembers, leaveGroup, muteEnd,
};
