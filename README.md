# Smart Planner Bot

A Telegram bot built with Node.js, grammY, and PostgreSQL to let users save daily, monthly, and yearly goals. Includes a subscription model (paywall) planned for later development.

## What I added

- `package.json` with required dependencies
- `.env.example` showing required environment variables
- `db.js` PostgreSQL Pool wrapper (exports `query` and `pool`)
- `index.js` grammY bot with `/start` and `/help` commands. `/start` registers the user in the `users` table if missing.
- `.gitignore` and `README.md`

## Required environment variables

Copy `.env.example` to `.env` and fill the values:

- BOT_TOKEN - Telegram bot token
- DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME - PostgreSQL connection
- Or use `DATABASE_URL` instead of separate DB_* vars

## Install and run (PowerShell)

```powershell
cd "c:\Users\user\OneDrive\Desktop\Fayllar\Smart-planner-bot"
npm install
npm start
```

## Database schema (already created by you)

Your `users` and `plans` tables should exist. Example SQL if needed:

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  full_name TEXT,
  subscription_status TEXT,
  subscription_end_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE plans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  plan_type TEXT,
  is_completed BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
```

## Next steps (suggested)

- Run `npm install` to install dependencies
- Create a `.env` using `.env.example` values
- Start the bot and test `/start` using your Telegram account
- Implement plan creation, listing, completion, and subscription/paywall flows

If you want, I can now run `npm init` / `npm install` in a terminal and start the bot for you, or add command handlers for adding/listing plans. Which would you prefer next?
