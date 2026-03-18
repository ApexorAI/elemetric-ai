-- ── Trial Period Migration ────────────────────────────────────────────────────
-- Adds trial_started_at to the profiles table.
-- A 14-day trial begins the moment a user signs up (set by the user-created webhook).
-- After 14 days, trial_expired = true unless the user has an active paid plan.
--
-- Run this migration in your Supabase SQL editor or via the CLI.

-- 1. Add trial_started_at column to profiles (if it does not already exist)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ DEFAULT NULL;

-- 2. Add an index so trial expiry queries are fast
CREATE INDEX IF NOT EXISTS idx_profiles_trial_started_at
  ON profiles (trial_started_at);

-- 3. Backfill: for existing users who have no trial_started_at set, use
--    their created_at as the trial start so they get 14 days from signup.
UPDATE profiles
SET    trial_started_at = created_at
WHERE  trial_started_at IS NULL
  AND  created_at IS NOT NULL;

-- 4. Optional helper view for quickly checking trial status across all users
-- (safe to use in Supabase Studio for monitoring)
CREATE OR REPLACE VIEW trial_status AS
SELECT
  id,
  email,
  plan,
  trial_started_at,
  created_at,
  CASE
    WHEN trial_started_at IS NULL THEN false
    WHEN (NOW() - trial_started_at) < INTERVAL '14 days' THEN true
    ELSE false
  END AS trial_active,
  CASE
    WHEN trial_started_at IS NULL THEN 0
    ELSE GREATEST(0, 14 - EXTRACT(EPOCH FROM (NOW() - trial_started_at)) / 86400)::INT
  END AS trial_days_remaining,
  CASE
    WHEN trial_started_at IS NULL THEN false
    WHEN (NOW() - trial_started_at) >= INTERVAL '14 days' THEN true
    ELSE false
  END AS trial_expired
FROM profiles;
