# Telegram feedback bot

Two things in one small bot: a feedback inbox for Telegram users, and an admin-only WhatsApp helper.

The feedback side stores submissions locally for administrator review. The WhatsApp side pairs one account of your own
by phone number and sends a single message per command to one destination. It has no bulk send, no reporting, no
campaign or reminder loops, and no automated outreach: it is a remote control for the account you paired, nothing more.

## Run

```sh
cp .env.example .env
# Set BOT_TOKEN and ADMIN_IDS in .env
npm install
npm start
```

## Commands

Users: `/start`, `/feedback <message>`, `/feedback`, `/myfeedback`, `/cancel`, `/help`

Admins: `/inbox [page]`, `/reply <id> <message>`, `/resolve <id>`, `/adminstats`, `/adminhelp`

WhatsApp (admins): `/wa` for the button menu, `/pair <number>`, `/send <number|group-id> <text>`,
`/chat <number|group>`, `/groups`, `/media`, `/unpair`, `/cancelwa`

## Behaviour

- `/feedback` with a message stores it straight away. On its own, it arms a prompt that accepts the next message and expires after `PENDING_TTL_SECONDS`.
- Submissions are trimmed, capped at `FEEDBACK_MAX_LEN`, and rate limited to one every `RATE_LIMIT_SECONDS` per user. A rejected submission leaves an armed prompt armed, so nothing is silently swallowed.
- `/inbox` pages through open feedback with `INBOX_PAGE_SIZE` per page, splitting long lists across several messages so Telegram's 4096-character limit is never hit.
- `/reply <id> <message>` sends the answer to the reporter, stores it on the record and closes the item. If the reply cannot be delivered (for example the user blocked the bot), the item stays open and the admin is told.
- `/resolve <id>` closes an item and sends the reporter a short note. Both commands record which admin acted.
- `/myfeedback` shows a user their own last five submissions with status and any reply.

## WhatsApp pairing

`/wa` opens a menu of actions: status, pair, send a message, list groups, check a number, recent sends.

Pairing is by phone number, not QR:

1. Run `/pair +233241234567` (full international format, or set `WA_DEFAULT_COUNTRY` to accept local numbers).
2. The bot replies with an 8-character code from WhatsApp.
3. On the phone holding that account: Settings → Linked devices → Link a device → Link with phone number instead, then type the code.

The session is saved to `WA_AUTH_DIR`, so the bot reconnects on its own after a restart. `/unpair` logs out and deletes it.

### Chat actions

`/chat <number|group>` opens the same set of actions the in-chat menu offers, one tap each: mute for 8 hours, a week
or forever, unmute, pin, unpin, archive, unarchive, mark as read, clear messages, delete the chat, block, unblock,
report, copy the last message, and contact info (on WhatsApp or not, about text, profile photo URL).

**Copy** returns the newest message text received in that chat, so you can select it in Telegram. Only messages seen
while the bot is connected are held.

**Report** asks for confirmation first, because it is not reversible: "Report" or "Report and block", and WhatsApp gets
the same spam signal the web client sends. There is no public API for it and WhatsApp never confirms receipt, so treat
a report as a signal rather than a guaranteed removal. Report and block a number from here when the phone's own menu
will not cooperate.

Groups add invite link, member list with admins marked, and leave. Every action is a single app-state patch on the
paired account; nothing is queued or repeated.

### Saving media

Received photos, videos, documents, voice notes and stickers are indexed in memory as they arrive (`WA_INBOX_LIMIT`,
oldest dropped first). "Save media" lists the recent ones and tapping one downloads it and delivers the file to
Telegram, wrapped view-once and disappearing media included. The index is memory only, so it empties on restart; the
media itself still lives in your WhatsApp chat.

Guards against a ban: one message per `WA_SEND_MIN_INTERVAL_MS`, at most `WA_SEND_HOURLY_CAP` per rolling hour, and no
group broadcasting — the bot sends one message per command, to one destination. Every send is recorded in `wa_sends`
with its outcome, visible through the "Recent sends" button.

If pairing fails the code simply expires: the bot says so and you request a fresh one. A `loggedOut` (401) after a
working session means the phone removed the linked device; the stored credentials are cleared and you pair again.

## Configuration

All optional apart from `BOT_TOKEN` and `ADMIN_IDS`, which are described in `.env.example`.

## Test

```sh
npm test
```

The smoke test covers storage, resolution, replies, per-user history, pagination, and admin id parsing. Database columns added after the first release (`reply_text`, `resolved_by`) are created automatically on startup, so an existing `feedback.db` keeps working.
