CREATE TABLE IF NOT EXISTS failed_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,
  recipient    TEXT,
  subject      TEXT,
  body_preview TEXT,
  error        TEXT,
  attempts     INTEGER DEFAULT 1,
  last_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved     BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_failed_notif_resolved ON failed_notifications(resolved);
