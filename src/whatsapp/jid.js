// Phone number and JID helpers shared by the WhatsApp session and its Telegram UI.

const NON_DIGITS = /\D+/g;

function digitsOnly(raw) {
  return String(raw ?? '').replace(NON_DIGITS, '');
}

// Accepts "+233 24 123 4567", "233241234567", or a local "0241234567" when a default country is set.
function toPhoneDigits(raw, defaultCountry = '') {
  let digits = digitsOnly(raw);
  if (!digits) return null;
  const country = digitsOnly(defaultCountry);
  if (country && digits.length <= 10 && !digits.startsWith(country)) {
    digits = country + digits.replace(/^0+/, '');
  } else if (!country && digits.startsWith('0')) {
    // A trunk-prefixed local number without a default country: we cannot know where it belongs.
    return null;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function isGroupJid(value) {
  return typeof value === 'string' && value.endsWith('@g.us');
}

// A user JID without the device suffix Baileys sometimes appends (e.g. 233241234567:12@s.whatsapp.net).
function bareJid(value) {
  if (typeof value !== 'string') return '';
  const [user, server] = value.split('@');
  if (!server) return value;
  const bare = user.split(':')[0].replace(/^\+/, '');
  return `${bare}@${server}`;
}

function toUserJid(raw, defaultCountry = '') {
  const digits = toPhoneDigits(raw, defaultCountry);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

// Group JIDs pass through untouched; anything else is treated as a phone number.
function toJid(raw, defaultCountry = '') {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (isGroupJid(value)) return bareJid(value);
  if (value.includes('@')) return bareJid(value);
  return toUserJid(value, defaultCountry);
}

function jidLabel(jid) {
  if (!jid) return 'unknown';
  if (isGroupJid(jid)) return `group ${jid.split('@')[0]}`;
  return `+${jid.split('@')[0]}`;
}

module.exports = { digitsOnly, toPhoneDigits, toUserJid, toJid, isGroupJid, bareJid, jidLabel };
