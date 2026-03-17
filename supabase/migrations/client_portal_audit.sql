CREATE TABLE IF NOT EXISTS client_portal_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action      TEXT NOT NULL,
  email       TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_audit_email ON client_portal_audit(email);
CREATE INDEX IF NOT EXISTS idx_client_audit_created ON client_portal_audit(created_at);
