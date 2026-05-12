-- Migration: Use telegram_id in plans table
-- Date: 2026-05-12
-- This migration adds a telegram_id column to the plans table, populates it from users(id) -> users(telegram_id),
-- adds a foreign key constraint referencing users(telegram_id), and drops the old user_id column.
-- IMPORTANT: Backup your DB before running this migration.

BEGIN;

-- 1) Add telegram_id column (nullable for now)
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS telegram_id BIGINT;

-- 2) Populate telegram_id from users table where possible
UPDATE plans
SET telegram_id = u.telegram_id
FROM users u
WHERE plans.user_id = u.id
  AND plans.telegram_id IS NULL;

-- 3) (Optional) Inspect orphaned plans before dropping anything
-- SELECT * FROM plans WHERE telegram_id IS NULL LIMIT 50;

-- 4) Create the foreign key constraint on telegram_id
ALTER TABLE plans
  ADD CONSTRAINT IF NOT EXISTS plans_telegram_id_fkey FOREIGN KEY (telegram_id)
  REFERENCES users (telegram_id) ON DELETE CASCADE;

-- 5) Drop the old foreign key constraint (if it exists) that referenced users(id)
ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_user_id_fkey;

-- 6) Drop the old user_id column (only if you're sure)
ALTER TABLE plans
  DROP COLUMN IF EXISTS user_id;

-- 7) Add an index on telegram_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_plans_telegram_id ON plans (telegram_id);

COMMIT;
