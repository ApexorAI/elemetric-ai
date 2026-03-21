# Rate Limiting Audit
**Date:** Sunday 22 March 2026
**Task:** 5 of 15

## Rate Limiters Configured

| Limiter | Scope | Window | Max Requests |
|---------|-------|--------|-------------|
| `globalLimiter` | All endpoints, per IP | 15 minutes | 20 requests |
| `reviewLimiter` | POST /review, per IP | 1 minute | 30 requests |
| `stampLimiter` | POST /stamp-photo, per IP | 15 minutes | 30 requests |
| `visualiserLimiter` | POST /visualise, per IP | 10 minutes | 3 requests |
| `clientVerifyLimiter` | Client portal verify, per IP+email | 1 hour | 3 attempts |
| Per-user /review | POST /review, per bearer token | 1 day (Sydney midnight) | 10–50 (plan-based) |
| Per-user /chat | POST /chat, per userId | 1 day (midnight UTC) | 20–100 (plan-based) |

## New Security Controls Added

### IP Block After Excessive Failures
- **Threshold:** 100 failed requests (429) in 1-minute window
- **Block duration:** 10 minutes
- **Implementation:** `trackIpFailure()` / `isIpBlocked()` — checked on every request

### Auth Brute Force Protection
- **Threshold:** 10 failed auth attempts from same IP
- **Block duration:** 1 hour
- **Implementation:** `trackAuthFailure()` / `isAuthBlocked()` — checked before API key verification

### Rate Limit Event Logging
- Every 429 response is logged to `SECURITY_LOG` with IP, path, method
- Blocked IPs visible via `GET /security-log`

## POST /review Rate Limiting (per user, not just per IP)
Users may share IPs (shared office, VPN). Per-user limits are enforced via:
1. Bearer token tracking (anonymous users get IP-based limits only)
2. Supabase profile lookup to determine plan tier
3. Sydney-timezone daily reset to match Australian business day

## POST /chat Rate Limiting
Chat daily limits are tracked in `chatDailyUsage` Map per `userId`. This is in-memory — resets on server restart. For true persistence across deploys, move to Supabase (recommended post-launch enhancement).

## Auth Endpoint Rate Limits
- Auth endpoints don't exist on this server (authentication is handled by Supabase Auth)
- All API key auth failures are rate-limited via the global IP block system

## Recommendation
After launch, tighten `reviewLimiter` from 30/min to 15/min. The current limit was increased for launch week testing.
