CREATE TABLE IF NOT EXISTS regulatory_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  update_id   TEXT NOT NULL,
  standard    TEXT,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email_sent  BOOLEAN DEFAULT false,
  UNIQUE(user_id, update_id)
);
CREATE INDEX IF NOT EXISTS idx_reg_notif_user ON regulatory_notifications(user_id);
