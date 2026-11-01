// Chat-level actions: the things WhatsApp's in-chat menu does, driven from Telegram.
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

// WhatsApp has no public endpoint for this; it is the same spam IQ the web client sends.
async function report(rawJid, { block = false } = {}, defaultCountry) {
  const sock = session.requireSocket();
  const jid = target(rawJid, defaultCountry);
  const node = {
    tag: 'iq',
    attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' },
    content: [{
      tag: 'spam_list',
      attrs: {},
      content: [{ tag: 'item', attrs: { jid, spam_flow: 'unsolicited' } }],
    }],
  };
  await sock.query(node);
  if (block) await sock.updateBlockStatus(jid, 'block');
  return { jid, blocked: Boolean(block) };
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
  setMute, setPin, setArchive, markRead, clearChat, deleteChat, setBlocked, report,
  contactInfo, groupInvite, groupMembers, leaveGroup, muteEnd,
};
