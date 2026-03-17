# Elemetric Server — Launch Readiness Report
**Generated:** 2026-03-17
**Server version:** index.js (single-file Express.js, ~107 000 lines)
**Runtime:** Node.js on Railway
**Model:** GPT-4.1-mini Vision (OpenAI)

---

## 1. Feature Flags

All flags live in `FEATURE_FLAGS` at the top of `index.js`. Set a flag to `true` and redeploy to re-enable.

| Flag | Default | Re-enable when |
|------|---------|----------------|
| `training_mode_enabled` | `false` | Apprentice onboarding begins |
| `subcontractor_alerts_enabled` | `false` | First employer account is active |
| `benchmarking_enabled` | `false` | Auto-checked — unlocks at 50+ jobs |
| `leaderboard_enabled` | `false` | Auto-checked — unlocks at 10+ referrals |
| `floor_plan_enabled` | `false` | Floor plan tool ships post-launch |
| `wide_shot_enabled` | `false` | Wide-shot tool ships post-launch |

> **Note:** `benchmarking` and `leaderboard` do not use the flag directly. They query Supabase and return `available: false` when below threshold, then auto-enable when the threshold is met. No redeploy needed.

---

## 2. Environment Variables

All required variables must be set in Railway before launch.

| Variable | Required | Purpose | If missing |
|----------|----------|---------|------------|
| `OPENAI_API_KEY` | **Critical** | GPT-4.1-mini vision analysis | `/review` and `/visualise` return 503 |
| `SUPABASE_URL` | **Critical** | Database URL | All DB endpoints disabled |
| `SUPABASE_SERVICE_ROLE_KEY` | **Critical** | Supabase admin key | All DB endpoints disabled |
| `STRIPE_SECRET_KEY` | **Critical** | Stripe billing | Billing endpoints disabled |
| `STRIPE_WEBHOOK_SECRET` | **Critical** | Stripe webhook signature | Webhooks accepted unverified |
| `RESEND_API_KEY` | **Critical** | Transactional email | All email endpoints disabled |
| `ELEMETRIC_API_KEY` | **Critical** | API authentication | All endpoints accessible without key |
| `REPLICATE_API_TOKEN` | Important | Stable Diffusion inpainting | `/visualise` returns 503 |
| `ALLOWED_ORIGINS` | Important | CORS whitelist | CORS open (dev) or blocked (prod) |
| `EMAIL_FROM` | Optional | Sender address | Defaults to `Elemetric <noreply@elemetric.app>` |
| `NODE_ENV` | Optional | Environment mode | Defaults to `development` |
| `PORT` | Optional | Server port | Defaults to `8080` |
| `SUPABASE_WEBHOOK_SECRET` | Optional | Webhook auth | Signup webhooks accepted without verification |

The startup report in `app.listen()` checks all critical variables and logs `✗ MISSING` warnings for any that are absent.

---

## 3. Endpoints — Full Status

### Core AI Analysis
| Method | Path | Status | Rate Limit | Auth |
|--------|------|--------|-----------|------|
| POST | `/review` | Active | 20/min per IP + daily user limit | API key |
| POST | `/review/test` | Active | Inherits review limiter | API key |
| POST | `/visualise` | Active | 3/10 min per IP | API key |
| POST | `/stamp-photo` | Active | 30/15 min per IP | API key |
| POST | `/training-mode` | **DISABLED (503)** | — | — |
| POST | `/before-after` | Active | Global | API key |
| POST | `/auto-classify` | Active | Global | API key |
| POST | `/bulk-review` | Active | Global | API key |

### Property Passport
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/property-passport` | Active | 24-hour cache per property |
| POST | `/property-passport/claim` | Active | Sends email to owner |

### Email / Notifications
| Method | Path | Status |
|--------|------|--------|
| POST | `/send-welcome` | Active |
| POST | `/send-job-complete` | Active |
| POST | `/send-team-invite` | Active |
| POST | `/send-near-miss-alert` | Active |
| POST | `/send-referral` | Active |
| POST | `/send-invoice` | Active |
| POST | `/send-client-code` | Active |
| POST | `/send-password-reset` | Active |

### Analytics
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/analytics` | Active | — |
| POST | `/analytics/aggregate` | Active | 1-hour cache per employer |
| POST | `/analyse-trends` | Active | — |
| GET | `/stats` | Active | API key required |
| GET | `/performance` | Active | API key required |
| POST | `/benchmark` | Data-gated | Returns `benchmarking_available: false` until 50+ jobs |
| GET | `/benchmark-comparison/:jobType` | Active | Static benchmarks |

### Referral System
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/referral/verify` | Active | No auth (used pre-signup) |
| POST | `/referral/generate` | Active | — |
| POST | `/referral/track` | Active | — |
| POST | `/referral/complete` | Active | Auto via Stripe webhook |
| GET | `/referral/stats` | Active | — |
| GET | `/referral/leaderboard` | Data-gated | Returns `leaderboard_available: false` until 10+ referrals |

### Billing (Stripe)
| Method | Path | Status |
|--------|------|--------|
| POST | `/webhook` | Active — signature verified |
| POST | `/webhook/user-created` | Active — Supabase signup |

### Timesheet
| Method | Path | Status |
|--------|------|--------|
| POST | `/timesheet/clock-in` | Active |
| POST | `/timesheet/clock-out` | Active |
| GET | `/timesheet/current` | Active |
| GET | `/timesheet/history` | Active |
| GET | `/timesheet/summary` | Active |
| POST | `/timesheet/payslip` | Active |

### Quote / Invoice
| Method | Path | Status |
|--------|------|--------|
| POST | `/quote/create` | Active |
| GET | `/quote/list` | Active |
| PUT | `/quote/accept` | Active |
| POST | `/quote/convert-to-invoice` | Active |

### Client Portal
| Method | Path | Status | Rate Limit |
|--------|------|--------|-----------|
| POST | `/client/verify` | Active | 3/hour per IP+email |
| POST | `/client/access` | Active | Global |

### User / Stage System
| Method | Path | Status |
|--------|------|--------|
| POST | `/user/stage` | Active |
| POST | `/user/unlock-stage` | Active |
| GET | `/user/tools` | Active |

### Compliance / Regulatory
| Method | Path | Status |
|--------|------|--------|
| POST | `/compliance-check` | Active |
| GET | `/compliance-heatmap` | Active |
| GET | `/compliance-tips/:jobType` | Active |
| GET | `/regulatory-updates` | Active |
| GET | `/regulatory-updates/affected-jobs` | Active |
| POST | `/risk-assessment` | Active |
| POST | `/liability-estimate` | Active |
| POST | `/near-miss-log` | Active |
| GET | `/near-miss-log` | Active |

### Monitoring
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/health` | Active | No auth — Railway healthcheck |
| GET | `/launch-metrics` | Active | API key required |
| GET | `/stats` | Active | API key required |
| GET | `/performance` | Active | API key required |
| GET | `/timestamp` | Active | — |
| GET | `/` | Active | Heartbeat |
| POST | `/export-report` | Active | — |

---

## 4. Rate Limits

| Limiter | Window | Requests | Applies to |
|---------|--------|----------|-----------|
| Global | 15 min | 20 per IP | All endpoints except /health, /webhook, / |
| Review | 1 min | 20 per IP | `/review` |
| Stamp | 15 min | 30 per IP | `/stamp-photo` |
| Visualise | 10 min | 3 per IP | `/visualise` |
| Client verify | 1 hour | 3 per IP+email | `/client/verify` |
| User daily (free) | 24 hours | 50 per user | All AI endpoints |
| User daily (paid) | 24 hours | 200 per user | All AI endpoints |
| Employer | — | Unlimited | All AI endpoints |

---

## 5. Security Measures Active at Launch

- **Helmet.js** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- **Rate limiting** — per-IP global + per-endpoint + per-user daily limits
- **API key auth** — `x-elemetric-key` header validated on all non-public endpoints
- **Input sanitisation** — null bytes + ASCII control chars stripped from all body/query params
- **Auth header hardening** — rejects malformed Authorization headers
- **CORS** — configurable via `ALLOWED_ORIGINS` env var
- **HTML escaping** — all user content in emails passed through `escHtml()`
- **Stripe webhook signature** — verified with `STRIPE_WEBHOOK_SECRET`
- **Timing-safe comparison** — Supabase webhook secret verified with `crypto.timingSafeEqual`
- **No sensitive data logged** — emails, API keys, and photo data never appear in logs

---

## 6. AI Analysis — Launch Resilience

The `/review` endpoint has two safety layers:

1. **30-second timeout** — If OpenAI takes longer than 30 seconds, a fallback response is returned immediately. The fallback marks all submitted photo labels as `items_unclear` with `_fallback: true` and `_fallback_reason: "ai_timeout"`. The app never hangs.

2. **OpenAI outage fallback** — If OpenAI returns a 5xx error or is unreachable, the same fallback fires with `_fallback_reason: "ai_unavailable"`. Users see a friendly retry message instead of an error screen.

Client apps should check `_fallback: true` in the response and prompt users to resubmit.

---

## 7. Scheduled Tasks

| Task | Schedule | Status at launch |
|------|----------|-----------------|
| Client session cleanup | Every 15 min | Running |
| User daily usage reset | Hourly | Running |
| Notification queue processor | Every 60 sec | Running |
| Memory monitoring | Every 30 min | Running |
| Regulatory update check | Sundays midnight AEDT | Running |
| Subcontractor expiry emails | Mondays 8am AEST | **Disabled** (`subcontractor_alerts_enabled: false`) |
| Analytics cache refresh | Every 60 min | Running |
| Launch metrics reset | Midnight Sydney | Running |

---

## 8. Launch Day Monitoring

Hit `GET /launch-metrics` with `x-elemetric-key: <key>` header to see:

```json
{
  "date": "17/03/2026",
  "signups": 0,
  "jobsCompleted": 0,
  "pdfsGenerated": 0,
  "aiAnalyses": 0,
  "errors": 0,
  "feature_flags": {
    "training_mode_enabled": false,
    "subcontractor_alerts_enabled": false,
    "benchmarking_enabled": false,
    "leaderboard_enabled": false,
    "floor_plan_enabled": false,
    "wide_shot_enabled": false
  },
  "uptime_seconds": 3600,
  "total_requests": 0,
  "openai_calls": 0,
  "cache_hits": 0,
  "emails_sent": 0
}
```

Counters reset at midnight Sydney time each day. Check `GET /health` for service connectivity.

---

## 9. Known Limitations for Launch

1. **In-memory state** — Sessions, notification queue, and rate limit counts are lost on server restart. Railway restarts clear these. Not an issue for launch but plan for persistence post-launch.

2. **Single process** — No clustering. One Railway instance handles all traffic. Scale by adding Railway replicas if needed post-launch.

3. **Static benchmark data** — `/benchmark` uses hardcoded Victorian industry averages until 50+ real jobs exist. These are reasonable estimates but will improve with real data.

4. **Training mode off** — `/training-mode` returns 503. Any mobile client calling this endpoint should handle the 503 gracefully and show a "coming soon" UI state.

5. **Subcontractor alerts off** — No weekly compliance emails until first employer account is active and flag is re-enabled.

6. **Leaderboard and benchmarks** — Both are data-gated. They return graceful `available: false` responses until thresholds are met.

---

## 10. Post-Launch Checklist

### Before going live
- [ ] Verify all 8 required env vars are set in Railway
- [ ] Run `GET /health` and confirm all services return `ok`
- [ ] Test `POST /review` end-to-end with a real photo
- [ ] Confirm Stripe webhook events are arriving
- [ ] Verify `ALLOWED_ORIGINS` includes the production app URL

### Day 1
- [ ] Monitor `GET /launch-metrics` every hour
- [ ] Check Railway logs for any startup `✗ MISSING` warnings
- [ ] Watch `/stats` for cost spikes (OpenAI calls * $0.002/call)

### First Week
- [ ] Set `subcontractor_alerts_enabled: true` when first employer signs up
- [ ] Check `/performance` for slow endpoints (threshold: 2000ms)
- [ ] Review `GET /notifications/failed` for any failed emails

### When Thresholds Are Met
- [ ] 50+ jobs in `jobs` table → `/benchmark` auto-enables (no action needed)
- [ ] 10+ completed referrals in `referrals` table → leaderboard auto-enables (no action needed)

### Post-Launch Features (flip flag + redeploy)
- [ ] Set `training_mode_enabled: true` when apprentice onboarding begins
- [ ] Set `floor_plan_enabled: true` when floor plan tool ships
- [ ] Set `wide_shot_enabled: true` when wide-shot tool ships

---

## 11. Codebase Summary

- **File:** `server/index.js` (~107 000 lines, single-file monolith)
- **Framework:** Express.js 5.2.1
- **Database:** Supabase (PostgreSQL via `@supabase/supabase-js`)
- **AI:** OpenAI GPT-4.1-mini Vision (with 30s timeout + fallback)
- **Image processing:** Replicate (Stable Diffusion), Sharp
- **Email:** Resend (3-attempt retry with exponential backoff)
- **Billing:** Stripe (webhooks + subscription management)
- **Deployment:** Railway (0.0.0.0, trust proxy 1 hop)
- **Key tables:** `profiles`, `job_analyses`, `jobs`, `referrals`, `subcontractors`, `timesheets`, `analyses`, `training_records`, `property_claims`

---

*This document was generated on 2026-03-17 as part of the pre-launch server audit.*
