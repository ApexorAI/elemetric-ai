-- Referral system tables
-- Run this migration in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS referrals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referred_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  code          TEXT UNIQUE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed_up', 'completed', 'paid')),
  commission_aud NUMERIC(10,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_up_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  paid_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code     ON referrals(code);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals(status);

-- Add referral_code column to profiles if not exists
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referred_by   TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_referral_earnings_aud NUMERIC(10,2) DEFAULT 0;

-- RLS
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Users can view own referrals" ON referrals FOR SELECT USING (auth.uid() = referrer_id);
