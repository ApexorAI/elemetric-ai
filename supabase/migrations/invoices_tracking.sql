-- Migration: invoice tracking columns
-- The invoices table already exists. This migration adds team_id and
-- sent_at / paid_at tracking columns if they don't already exist.
-- Run in Supabase SQL Editor

-- Add team_id if missing (for employer scoping)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS team_id uuid;

-- Add sent_at timestamp
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- Add paid_at timestamp
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- Add status column if not already present (some installs may have it as text already)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status text DEFAULT 'PENDING';

-- Update status to OVERDUE for invoices past due date (run as a one-time backfill)
UPDATE invoices
SET status = 'OVERDUE'
WHERE status IN ('PENDING', 'SENT')
  AND due_date IS NOT NULL
  AND due_date < now();

-- RLS: employer sees team invoices
-- Note: RLS may already be enabled on invoices. This adds the employer policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'invoices' AND policyname = 'invoices_employer_select'
  ) THEN
    EXECUTE 'CREATE POLICY "invoices_employer_select" ON invoices
      FOR SELECT USING (
        team_id IS NOT NULL AND
        team_id = (
          SELECT team_id FROM profiles WHERE id = auth.uid() LIMIT 1
        )
      )';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS invoices_team_id_idx ON invoices (team_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (status);
