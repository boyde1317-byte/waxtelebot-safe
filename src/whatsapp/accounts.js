// The roster of linked WhatsApp accounts and which one each admin is driving.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const log = require('../utils/logger');
const inbox = require('./inbox');
const { createSession } = require('./session');

const sessions = new Map(); // account id -> session
const activeByAdmin = new Map(); // admin telegram id -> account id
const listeners = new Set(); // global session listeners (admin notifications)

function newAccountDir() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return path.join(config.waAccountsDir, `account-${stamp}-${rand}`);
}

// A single-session install keeps its pairing: register the old auth folder.
function migrateLegacySession() {
  if (db.listAccounts().length) return null;
  const legacyCreds = path.join(config.waAuthDir, 'creds.json');
  if (!fs.existsSync(legacyCreds)) return null;
  const row = db.createAccount({ label: 'Main', authDir: config.waAuthDir });
  log.info('Adopted the existing WhatsApp session as %s', row.label);
  return row;
}

function attach(row) {
  const session = createSession({
    id: row.id,
    label: row.label || `Account ${row.id}`,
    authDir: row.auth_dir,
  });
  session.setIncomingHandler((message, info) => inbox.record(message, info));
  for (const listener of listeners) session.subscribe(listener);
  sessions.set(row.id, session);
  return session;
}

// One subscription for every account, including ones added later.
function subscribeAll(fn) {
  listeners.add(fn);
  for (const session of sessions.values()) session.subscribe(fn);
  return () => listeners.delete(fn);
}

function init() {
  if (!config.waEnabled) return [];
  migrateLegacySession();
  const rows = db.listAccounts();
  for (const row of rows) attach(row);
  log.info('WhatsApp accounts loaded: %d', rows.length);
  return list();
}

// Reconnects every paired account, one at a time so the handshakes do not collide.
async function restoreAll() {
  const rows = db.listAccounts();
  for (const row of rows) {
    const session = sessions.get(row.id);
    if (!session || !session.hasCreds()) continue;
    await session.restore();
    await new Promise(resolve => setTimeout(resolve, config.waRestoreGapMs));
  }
  return list();
}

function create(label = null) {
  if (!config.waEnabled) throw new Error('WhatsApp is disabled by configuration.');
  if (db.listAccounts().length >= config.waMaxAccounts) {
    throw new Error(`That is the limit: ${config.waMaxAccounts} accounts. Unpair one first.`);
  }
  const row = db.createAccount({ label: label || '', authDir: newAccountDir() });
  const fresh = db.updateAccount(row.id, { label: label || `Account ${row.id}` });
  return attach(fresh);
}

async function remove(id) {
  const session = sessions.get(id);
  if (session) await session.logout();
  sessions.delete(id);
  for (const [adminId, accountId] of activeByAdmin) {
    if (accountId === id) activeByAdmin.delete(adminId);
  }
  db.deleteAccount(id);
  return true;
}

function list() {
  return db.listAccounts().map(row => {
    const session = sessions.get(row.id);
    return {
      id: row.id,
      label: row.label || `Account ${row.id}`,
      phone: row.phone,
      jid: row.jid,
      status: session ? session.status() : { state: 'idle', connected: false, hasCreds: false },
    };
  });
}

// A number can only hold one session here: pairing it twice adds a second
// linked device to the same account instead of a separate account.
function phoneClash(phone, exceptId = null) {
  if (!phone) return null;
  const hit = list().find(row => row.phone === phone && row.id !== Number(exceptId) && row.status.hasCreds);
  return hit || null;
}

function get(id) {
  return sessions.get(Number(id)) || null;
}

// The account an admin's next action applies to: their choice, else the first
// connected account, else the first one at all.
function active(adminId) {
  const chosen = activeByAdmin.get(adminId);
  if (chosen && sessions.has(chosen)) return sessions.get(chosen);
  const rows = list();
  const connected = rows.find(row => row.status.connected);
  const pick = connected || rows[0];
  return pick ? sessions.get(pick.id) || null : null;
}

function setActive(adminId, id) {
  if (!sessions.has(Number(id))) return false;
  activeByAdmin.set(adminId, Number(id));
  return true;
}

async function stopAll() {
  for (const session of sessions.values()) await session.stop();
}

function summaryLine(adminId) {
  const rows = list();
  if (!rows.length) return 'No WhatsApp accounts linked.';
  const current = active(adminId);
  const connected = rows.filter(row => row.status.connected).length;
  if (!current) return `${rows.length} linked, ${connected} connected.`;
  return `${current.snapshot.label}${current.snapshot.number ? ` +${current.snapshot.number}` : ''} · ${connected}/${rows.length} connected`;
}

module.exports = {
  init, restoreAll, subscribeAll, create, remove, list, get, active, setActive, stopAll,
  summaryLine, newAccountDir, phoneClash,
};
