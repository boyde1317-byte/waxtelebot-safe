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

Users: `/start`, `/feedback`, `/cancel`, `/help`

Admins: `/inbox`, `/resolve <feedback_id>`, `/adminstats`

Run the local test with `npm test`.
