# Elemetric Server — Production Readiness Report

Generated: 2026-03-17

## npm audit
```
found 0 vulnerabilities
```
All dependencies clean. No security patches required.

---

## Environment Variables Required

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes | AI photo analysis, all /review endpoints |
| `REPLICATE_API_TOKEN` | Yes | AC unit visualiser (Stable Diffusion) |
| `SUPABASE_URL` | Yes | All database operations |
| `SUPABASE_SERVICE_KEY` | Yes | Admin DB access (RLS bypass) |
| `STRIPE_SECRET_KEY` | Yes | Billing, subscription management |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signature verification |
| `RESEND_API_KEY` | Yes | Transactional email |
| `ELEMETRIC_API_KEY` | Yes | API key authentication |
| `EMAIL_FROM` | Recommended | Sender address (default: onboarding@elemetric.app) |
| `ALLOWED_ORIGINS` | Recommended | CORS whitelist (comma-separated) |
| `PORT` | Optional | Server port (default: 3000) |
| `NODE_ENV` | Optional | `production` to enable prod hardening |

---

## Rate Limiting

| Endpoint group | Limit |
|----------------|-------|
| Global | 100 req / 15 min per IP |
| `/review` | 20 req / 15 min per IP |
| `/stamp-photo` | 30 req / 15 min per IP |
| `/visualise` | 3 req / 10 min per IP |
| `/client/verify` | 3 req / 1 hour per IP+email |

---

## Security Controls

- Helmet.js: active (CSP, HSTS, X-Frame-Options, etc.)
- Rate limiting: active on all endpoints
- Input sanitisation: null-byte + control-char stripping
- API key auth: `x-api-key` header required on write endpoints
- HTML escaping: all user content passed through `escHtml()` before email
- Trust proxy: 1 hop (Railway load balancer)
- CORS: configurable via `ALLOWED_ORIGINS` env var

---

## Error Handling

- All endpoints wrapped in try/catch
- 400 for missing/invalid params
- 401/403 for auth failures
- 404 for missing resources
- 500 for server errors (logged to console)
- 503 when external services (Supabase, OpenAI) not configured

---

## Memory Management

- LRU cache: max 500 entries, 1-hour TTL
- pendingAnalyses: auto-evicted at 1000 entries
- clientSessions: auto-evicted at 1000 entries
- userDailyUsage: cleaned hourly
- Memory monitoring: logs heap/RSS every 30 minutes
- GC hint at 400MB heap (requires `--expose-gc` flag)
- Graceful shutdown: clears all caches on SIGTERM/SIGINT

---

## Background Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| Session cleanup | Every 15 min | Expire client portal sessions |
| Daily usage reset | Hourly | Clear userDailyUsage map |
| Notification queue | Every 1 min | Process scheduled notifications |
| Memory monitoring | Every 30 min | Heap logging + map eviction |
| Regulatory check | Sundays midnight AEDT | Email users affected by regulatory changes |
| Weekly sub email | Mondays 8am AEDT | Employer subcontractor compliance summary |
| Analytics cache refresh | Hourly | Clear stale employer analytics |

---

## Database Tables (Supabase)

| Table | Description |
|-------|-------------|
| `profiles` | User accounts, roles, licence info |
| `job_analyses` | All compliance job records |
| `jobs` | Job scheduling and tracking |
| `compliance_certificates` | Issued certificates |
| `referrals` | Referral tracking |
| `subcontractors` | Subcontractor profiles |
| `timesheets` | Timesheet records |
| `user_stages` | Progressive disclosure stage tracking |
| `client_portal_audit` | Client portal access audit log |
| `regulatory_notifications` | Regulatory update notifications sent |
| `failed_notifications` | Failed email retry queue |
| `property_claims` | Property owner claims |

---

## Health Checks

- `GET /health` — returns `{ status: "ok" }` + service connectivity
- `GET /performance` — response times per endpoint (API key required)
- `GET /stats` — usage statistics and cost estimates

---

## Deployment Checklist

- [ ] Set all required environment variables in Railway
- [ ] Run `npm audit` — confirm 0 vulnerabilities
- [ ] Verify Supabase migrations applied: `supabase/migrations/*.sql`
- [ ] Test `/health` endpoint returns OK
- [ ] Confirm Stripe webhook secret set correctly
- [ ] Test `/verify-certificate?id=test` returns 404 (not 500)
- [ ] Check `ALLOWED_ORIGINS` includes production frontend URL
- [ ] Enable `--expose-gc` flag in Node.js start command for GC hints
