CREATE TABLE IF NOT EXISTS timesheets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  employer_id UUID,
  job_id      TEXT,
  clock_in    TIMESTAMPTZ NOT NULL,
  clock_out   TIMESTAMPTZ,
  location    TEXT,
  notes       TEXT,
  hourly_rate NUMERIC(10,2),
  total_hours NUMERIC(8,2),
  total_pay   NUMERIC(10,2),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timesheets_user    ON timesheets(user_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_employer ON timesheets(employer_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_status  ON timesheets(status);
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
