-- Subcontractor management tables

CREATE TABLE IF NOT EXISTS subcontractors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id     UUID NOT NULL,
  full_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  abn             TEXT,
  licence_number  TEXT,
  licence_type    TEXT,
  licence_expiry  DATE,
  insurance_provider TEXT,
  insurance_policy_number TEXT,
  insurance_expiry DATE,
  trade_types     TEXT[],
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subcontractors_employer ON subcontractors(employer_id);
CREATE INDEX IF NOT EXISTS idx_subcontractors_status   ON subcontractors(status);

ALTER TABLE subcontractors ENABLE ROW LEVEL SECURITY;
