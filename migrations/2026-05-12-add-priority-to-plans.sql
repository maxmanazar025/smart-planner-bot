-- Migration: add priority column to plans
-- Date: 2026-05-12
-- Adds a priority text column to plans and sets default 'normal'

BEGIN;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal';

COMMIT;
