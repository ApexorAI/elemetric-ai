CREATE TABLE IF NOT EXISTS training_submissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID,
  job_type       TEXT,
  checklist_item TEXT,
  training_score INTEGER,
  ready_for_real_job BOOLEAN,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_training_user ON training_submissions(user_id);
