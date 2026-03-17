-- User stage progression system (controlled exposure / progressive disclosure)

CREATE TABLE IF NOT EXISTS user_stages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL UNIQUE,
  stage        INTEGER NOT NULL DEFAULT 1 CHECK (stage IN (1, 2, 3)),
  unlocked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  jobs_at_unlock INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_stages_user ON user_stages(user_id);
ALTER TABLE user_stages ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Users can view own stage" ON user_stages FOR SELECT USING (auth.uid() = user_id);
