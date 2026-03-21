# Authentication and Authorisation Audit
**Date:** Sunday 22 March 2026
**Task:** 4 of 15

## Authentication Architecture

### Global API Key Middleware (all endpoints)
All endpoints except `/`, `/webhook`, `/webhook/user-created`, `/health`, `/timestamp` require the `x-elemetric-key` header matching `ELEMETRIC_API_KEY`.

- **Implementation:** Lines 1410–1445 of `index.js`
- **Bypass resistance:** Constant-time string comparison; key presence required
- **Failure logging:** Auth failures logged to SECURITY_LOG with IP, path, method
- **Brute force protection:** After 10 auth failures from same IP → 1-hour block via `AUTH_FAIL_TRACKER`

### Per-User Daily Rate Limits (Supabase-backed)
`POST /review` and `POST /chat` additionally enforce per-user daily limits by fetching the user's plan from Supabase `profiles` table.

| Plan | /review limit | /chat limit |
|------|--------------|------------|
| free | 10/day | 20/day |
| trial (14 days) | 10/day | 20/day |
| individual/core/pro | 50/day | 100/day |
| employer | unlimited | 100/day |

### Stripe Webhook Authentication
`POST /webhook` — Stripe signature verified via `stripe.webhooks.constructEvent()` with `STRIPE_WEBHOOK_SECRET`. Invalid signatures return 400.

### Supabase Webhook Authentication
`POST /webhook/user-created` — `SUPABASE_WEBHOOK_SECRET` verified via `crypto.timingSafeEqual()` constant-time comparison.

## Endpoint Authentication Status

| Endpoint | Auth Required | Method |
|---------|--------------|--------|
| `GET /` | No | Heartbeat only |
| `GET /health` | No | Infrastructure check |
| `POST /webhook` | Stripe signature | Webhook secret |
| `POST /webhook/user-created` | Supabase secret | Header secret |
| `POST /review` | Yes + per-user limit | API key + daily limit |
| `POST /chat` | Yes + per-user limit | API key + daily limit |
| `POST /visualise` | Yes | API key |
| `GET /security-log` | Yes (admin) | API key |
| `GET /launch-metrics` | Yes | API key |
| All other endpoints | Yes | API key |

## Authorisation (per-resource access)

**User data isolation:** The Supabase service role key is used only server-side (never exposed to clients). Client requests include a Supabase JWT (Bearer token) which is validated by Supabase's own Row Level Security policies.

**RLS enforcement:** All `profiles`, `jobs`, `referrals` tables have Row Level Security enabled in Supabase (enforced at database layer — users can only access their own rows). The server-side service role bypasses RLS only for admin operations (plan updates, analytics queries).

**Job ownership:** Jobs are fetched only by user ID — cross-user access is blocked by RLS.

**Employer isolation:** Employer dashboard endpoints (`/analytics`, `/team-report`) are additionally checked by role field on the profile.

## Findings and Fixes

1. **Auth failure now logged** — previously silent 401, now logged with IP, path, and failure count
2. **Brute force protection added** — 10 auth failures triggers 1-hour IP block
3. **Auth failure response hardened** — now includes error code `ERR_UNAUTH` (no internal detail)
4. **IP blocked from auth requests** — `isAuthBlocked()` check added before key verification
