-- Migration: warranties table
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS warranties (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  uuid,
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id                 uuid,
  product_name            text NOT NULL,
  brand                   text,
  model_number            text,
  serial_number           text,
  install_date            date NOT NULL,
  warranty_period_years   integer NOT NULL CHECK (warranty_period_years > 0),
  expiry_date             date NOT NULL,
  warranty_card_photo_url text,
  client_address          text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE warranties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "warranties_user_select" ON warranties
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "warranties_user_insert" ON warranties
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "warranties_user_update" ON warranties
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "warranties_user_delete" ON warranties
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "warranties_employer_select" ON warranties
  FOR SELECT USING (
    team_id IS NOT NULL AND
    team_id = (
      SELECT team_id FROM profiles WHERE id = auth.uid() LIMIT 1
    )
  );

CREATE INDEX IF NOT EXISTS warranties_user_id_idx ON warranties (user_id);
CREATE INDEX IF NOT EXISTS warranties_job_id_idx ON warranties (job_id);
CREATE INDEX IF NOT EXISTS warranties_team_id_idx ON warranties (team_id);
CREATE INDEX IF NOT EXISTS warranties_expiry_date_idx ON warranties (expiry_date);
