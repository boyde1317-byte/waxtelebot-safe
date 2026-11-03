// Chat-level actions: the things WhatsApp's in-chat menu does, driven from Telegram.
const config = require('../config');
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

async function setMute(account, rawJid, durationMs, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().chatModify({ mute: muteEnd(durationMs) }, jid);
  return jid;
}

async function setPin(account, rawJid, pinned, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().chatModify({ pin: Boolean(pinned) }, jid);
  return jid;
}

async function setArchive(account, rawJid, archived, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().chatModify({ archive: Boolean(archived), lastMessages: [] }, jid);
  return jid;
}

async function markRead(account, rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().chatModify({ markRead: true, lastMessages: [] }, jid);
  return jid;
}

async function clearChat(account, rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().chatModify({ clear: true, lastMessages: [] }, jid);
  return jid;
}

async function deleteChat(account, rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().chatModify({ delete: true, lastMessages: [] }, jid);
  return jid;
}

async function setBlocked(account, rawJid, blocked, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().updateBlockStatus(jid, blocked ? 'block' : 'unblock');
  return jid;
}

// Reporting is undocumented. The only detailed wire format available comes from
// whatsapp-rust (the core Baileys 7 embeds through whatsapp-rust-bridge): the IQ
// reports a *message*, carries spam_flow on <spam_list>, and answers with report_id.
// Baileys itself exposes nothing for this and upstream calls it unsupported.

function reportIdFrom(result) {
  if (!result || typeof result !== 'object') return null;
  const children = Array.isArray(result?.content) ? result.content : [];
  for (const node of children) {
    if (node?.tag !== 'report_id') continue;
    if (Buffer.isBuffer(node.content)) {
      const str = node.content.toString('utf8').trim();
      return str.length ? str : null;
    }
    if (typeof node.content === 'string') {
      const str = node.content.trim();
      return str.length ? str : null;
    }
    const first = Array.isArray(node.content) ? node.content[0]?.content : null;
    if (first) {
      const str = String(first).trim();
      return str.length ? str : null;
    }
  }
  return null;
}

const SPAM_CATEGORIES = {
  spam: { flow: '1', label: 'Spam' },
  scam: { flow: '3', label: 'Scam / Fraud' },
  harass: { flow: '2', label: 'Harassment' },
  offensive: { flow: '4', label: 'Offensive Content' },
  general: { flow: 'MessageMenu', label: 'General' },
};

function formatMessageNode(item) {
  const { proto } = require('baileys');
  const messageAttrs = { id: item.id, t: String(Math.floor((item.at || Date.now()) / 1000)) };
  if (item.fromJid) messageAttrs.from = item.fromJid;
  if (item.isGroup && item.participant) messageAttrs.participant = item.participant;

  const messageChildren = [];
  if (item.inner) {
    const rawAttrs = { v: '3' };
    if (item.mediaType) rawAttrs.mediatype = item.mediaType;
    const bytes = proto.Message.encode(proto.Message.fromObject(item.inner)).finish();
    messageChildren.push({ tag: 'raw', attrs: rawAttrs, content: Buffer.from(bytes) });
  }
  return { tag: 'message', attrs: messageAttrs, content: messageChildren };
}

// Builds the spam IQ for an indexed message with up to 5 context messages. Exported so the shape can be tested.
function buildSpamIq(entry, { flow, subject = null, contextEntries = [] } = {}) {
  const spamFlow = flow || (entry.isGroup ? 'GroupInfoReport' : 'MessageMenu');
  const listAttrs = { spam_flow: String(spamFlow) };
  if (entry.isGroup) {
    listAttrs.jid = entry.jid;
    if (subject) listAttrs.subject = subject;
  }

  const allEntries = [entry];
  if (Array.isArray(contextEntries)) {
    for (const ctx of contextEntries) {
      if (ctx && ctx.id !== entry.id && allEntries.length < 5) {
        allEntries.push(ctx);
      }
    }
  }

  const messageNodes = allEntries.map(formatMessageNode);

  return {
    tag: 'iq',
    attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' },
    content: [{
      tag: 'spam_list',
      attrs: listAttrs,
      content: messageNodes,
    }],
  };
}

async function reportMessage(account, entry, { block = false, flow = null, subject = null, contextLimit = 5, contextEntries = null } = {}) {
  if (!entry?.id) throw new Error('There is no message to report.');

  const isConnected = account.status ? account.status().connected : Boolean(account.socket);
  if (!isConnected) {
    return {
      jid: entry.jid,
      status: 'disconnected',
      reportId: null,
      blocked: false,
      blockError: null,
      error: 'Not connected',
      flow: null,
    };
  }

  let recentMessages = contextEntries;
  if (!recentMessages) {
    try {
      const inbox = require('./inbox');
      recentMessages = inbox.list({ accountId: account.id, jid: entry.jid, limit: contextLimit });
    } catch {
      recentMessages = [entry];
    }
  }

  const sock = account.requireSocket();
  const node = buildSpamIq(entry, { flow, subject, contextEntries: recentMessages });
  let result;
  try {
    result = await sock.query(node, config.waQueryTimeoutMs);
  } catch (err) {
    const stillConnected = account.status ? account.status().connected : Boolean(account.socket);
    if (!stillConnected) {
      return {
        jid: entry.jid,
        status: 'disconnected',
        reportId: null,
        blocked: false,
        blockError: null,
        error: 'Not connected',
        flow: node.content[0]?.attrs?.spam_flow,
      };
    }
    throw err;
  }

  let status;
  if (result === undefined) {
    status = 'unanswered';
  } else if (!result || typeof result !== 'object' || result.tag !== 'iq') {
    status = 'invalid';
  } else if (result.attrs?.type === 'error') {
    status = 'error';
  } else if (result.attrs?.type === 'result') {
    const reportId = reportIdFrom(result);
    status = reportId ? 'confirmed' : 'unconfirmed';
  } else {
    status = 'unexpected';
  }

  const reportId = reportIdFrom(result);

  let blocked = false;
  let blockError = null;
  if (block) {
    try {
      await sock.updateBlockStatus(entry.jid, 'block');
      blocked = true;
    } catch (bErr) {
      blockError = bErr.message;
    }
  }

  return {
    jid: entry.jid,
    status,
    reportId,
    blocked,
    blockError,
    flow: node.content[0]?.attrs?.spam_flow,
  };
}

async function reportMessageAll(accountSessions, entry, { block = false, flow = null, subject = null } = {}) {
  if (!Array.isArray(accountSessions) || !accountSessions.length) {
    throw new Error('No paired sessions available to route report.');
  }
  const results = [];
  for (const session of accountSessions) {
    const label = session?.snapshot?.label || `Account ${session?.id}`;
    const number = session?.snapshot?.number ? `+${session.snapshot.number}` : null;
    try {
      const isConnected = session.status ? session.status().connected : Boolean(session.socket);
      if (!isConnected) {
        results.push({
          accountId: session.id,
          label,
          number,
          status: 'disconnected',
          reportId: null,
          blocked: false,
          error: 'Not connected',
        });
        continue;
      }
      const res = await reportMessage(session, entry, { block, flow, subject });
      results.push({
        accountId: session.id,
        label,
        number,
        status: res.status,
        reportId: res.reportId,
        blocked: res.blocked,
        error: null,
      });
    } catch (err) {
      results.push({
        accountId: session.id,
        label,
        number,
        status: 'failed',
        reportId: null,
        blocked: false,
        error: err.message,
      });
    }
  }
  return results;
}

// When any session reports a number/message, automatically cascade and trigger
// a report through all other paired sessions aboard.
async function reportWithAutoCascade(originSession, entry, { block = false, flow = null, subject = null, otherSessions = null } = {}) {
  const primary = await reportMessage(originSession, entry, { block, flow, subject });

  let others = otherSessions;
  if (!others) {
    try {
      const accounts = require('./accounts');
      const pairedRows = accounts.list().filter(a => a.id !== originSession.id && a.status.hasCreds);
      others = pairedRows.map(r => accounts.get(r.id)).filter(Boolean);
    } catch {
      others = [];
    }
  }

  const cascaded = [];
  if (Array.isArray(others) && others.length > 0) {
    for (const otherSession of others) {
      if (otherSession.id === originSession.id) continue;
      const label = otherSession?.snapshot?.label || `Account ${otherSession?.id}`;
      const number = otherSession?.snapshot?.number ? `+${otherSession.snapshot.number}` : null;
      try {
        const isConnected = otherSession.status ? otherSession.status().connected : Boolean(otherSession.socket);
        if (!isConnected) {
          cascaded.push({
            accountId: otherSession.id,
            label,
            number,
            status: 'disconnected',
            reportId: null,
            blocked: false,
            error: 'Not connected',
          });
          continue;
        }
        const res = await reportMessage(otherSession, entry, { block, flow, subject });
        cascaded.push({
          accountId: otherSession.id,
          label,
          number,
          status: res.status,
          reportId: res.reportId,
          blocked: res.blocked,
          error: null,
        });
      } catch (err) {
        cascaded.push({
          accountId: otherSession.id,
          label,
          number,
          status: 'failed',
          reportId: null,
          blocked: false,
          error: err.message,
        });
      }
    }
  }

  return { primary, cascaded };
}

async function contactInfo(account, rawJid, defaultCountry) {
  const sock = account.requireSocket();
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

async function groupInvite(account, rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  const code = await account.requireSocket().groupInviteCode(jid);
  if (!code) throw new Error('WhatsApp did not return an invite link for that group.');
  return { jid, link: `https://chat.whatsapp.com/${code}` };
}

async function groupMembers(account, rawJid, limit = 30, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  const meta = await account.requireSocket().groupMetadata(jid);
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

async function leaveGroup(account, rawJid, defaultCountry) {
  const jid = target(rawJid, defaultCountry);
  await account.requireSocket().groupLeave(jid);
  return jid;
}

module.exports = {
  setMute, setPin, setArchive, markRead, clearChat, deleteChat, setBlocked,
  reportMessage, reportMessageAll, reportWithAutoCascade, buildSpamIq, reportIdFrom,
  contactInfo, groupInvite, groupMembers, leaveGroup, muteEnd, SPAM_CATEGORIES,
};
