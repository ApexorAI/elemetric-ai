-- Migration: receipts table
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id        uuid,
  team_id       uuid,
  vendor        text,
  date          date,
  amount        decimal(10, 2) NOT NULL DEFAULT 0,
  gst_amount    decimal(10, 2) NOT NULL DEFAULT 0,
  category      text CHECK (category IN ('Materials', 'Tools', 'Fuel', 'Parking', 'Other')),
  photo_url     text,
  raw_text      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

-- Users see only their own receipts
CREATE POLICY "receipts_user_select" ON receipts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "receipts_user_insert" ON receipts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "receipts_user_update" ON receipts
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "receipts_user_delete" ON receipts
  FOR DELETE USING (auth.uid() = user_id);

-- Employers see team receipts (join via profiles.team_id)
CREATE POLICY "receipts_employer_select" ON receipts
  FOR SELECT USING (
    team_id IS NOT NULL AND
    team_id = (
      SELECT team_id FROM profiles WHERE id = auth.uid() LIMIT 1
    )
  );

-- Index for performance
CREATE INDEX IF NOT EXISTS receipts_user_id_idx ON receipts (user_id);
CREATE INDEX IF NOT EXISTS receipts_job_id_idx ON receipts (job_id);
CREATE INDEX IF NOT EXISTS receipts_team_id_idx ON receipts (team_id);
CREATE INDEX IF NOT EXISTS receipts_created_at_idx ON receipts (created_at DESC);
