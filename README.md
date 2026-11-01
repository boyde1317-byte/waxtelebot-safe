# Telegram feedback bot

This version accepts feedback from Telegram users and stores it locally for administrator review. It does not target WhatsApp accounts, coordinate reporting, broadcast campaign instructions, or send reminders.

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

## Behaviour

- `/feedback` with a message stores it straight away. On its own, it arms a prompt that accepts the next message and expires after `PENDING_TTL_SECONDS`.
- Submissions are trimmed, capped at `FEEDBACK_MAX_LEN`, and rate limited to one every `RATE_LIMIT_SECONDS` per user. A rejected submission leaves an armed prompt armed, so nothing is silently swallowed.
- `/inbox` pages through open feedback with `INBOX_PAGE_SIZE` per page, splitting long lists across several messages so Telegram's 4096-character limit is never hit.
- `/reply <id> <message>` sends the answer to the reporter, stores it on the record and closes the item. If the reply cannot be delivered (for example the user blocked the bot), the item stays open and the admin is told.
- `/resolve <id>` closes an item and sends the reporter a short note. Both commands record which admin acted.
- `/myfeedback` shows a user their own last five submissions with status and any reply.

## Configuration

All optional apart from `BOT_TOKEN` and `ADMIN_IDS`, which are described in `.env.example`.

## Test

```sh
npm test
```

The smoke test covers storage, resolution, replies, per-user history, pagination, and admin id parsing. Database columns added after the first release (`reply_text`, `resolved_by`) are created automatically on startup, so an existing `feedback.db` keeps working.
