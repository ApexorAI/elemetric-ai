# Elemetric Server — Launch Readiness Report
**Generated:** 2026-03-17 (updated 2026-03-20 post-session-5)
**Server version:** index.js (single-file Express.js, ~112 000 lines)
**npm audit:** 0 vulnerabilities (verified 2026-03-20)
**Runtime:** Node.js on Railway
**AI Models:** GPT-4.1-mini Vision (compliance analysis), GPT-4o-mini (prescreening), Claude Haiku 4.5 (compliance chatbot)
**PDF library:** pdfkit (server-side PDF generation)

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
| `ALLOWED_ORIGINS` | Optional | Additional CORS origins (comma-separated) | Hardcoded defaults cover elemetric.com.au and Railway URL |
| `EMAIL_FROM` | Optional | Sender address | Defaults to `Elemetric <noreply@elemetric.app>` |
| `NODE_ENV` | Optional | Environment mode | Defaults to `development` |
| `PORT` | Optional | Server port | Defaults to `8080` |
| `SUPABASE_WEBHOOK_SECRET` | Optional | Webhook auth | Signup webhooks accepted without verification |
| `ANTHROPIC_API_KEY` | Important | Claude Haiku chatbot | `/chat` returns 503 |

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

> **Mobile fix (2026-03-17):** `/review` now filters out `photoType="360"` and `photoType="wide_shot"` photos before analysis. Use `/process-360` for 360-degree content. Signature is not required for `/review` — only relevant at PDF export stage.

### Property Passport
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/property-passport` | Active | 24-hour cache per property |
| POST | `/property-passport/claim` | Active | Sends email to owner |

### Trial Period
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/check-trial` | Active | Returns trial_active, trial_days_remaining, trial_expired for a userId |
| POST | `/trial/start` | Active | Explicitly starts 14-day trial (idempotent — safe to call multiple times) |
| GET | `/trial/status?userId=` | Active | Returns full trial status; same fields as /check-trial |

### Compliance Chatbot
| Method | Path | Status | Rate Limit |
|--------|------|--------|------------|
| POST | `/chat` | Active | 20/day (free), 100/day (paid or trial) |
| POST | `/compliance-summary` | Active | Uses Claude Haiku — no separate rate limit |

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

### PDF Generation
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/export-report` | Active | Returns `{ pdf_base64, filename, size_kb }` + `Content-Type: application/pdf` |
| GET | `/pdf/:jobId` | Active | API key required — regenerates PDF for any past job |

> **Mobile fix (2026-03-17):** `/export-report` now generates a real server-side PDF using pdfkit. Returns base64-encoded PDF with filename. Includes 1 KB size validation. `/pdf/:jobId` is a new endpoint for retrieving any past job's PDF by ID without local storage.

### Employer Account Management
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/employer/upgrade` | Active | API key required — upgrades user to employer, creates team, sends welcome email |
| GET | `/employer/onboarding-status` | Active | API key required — powers employer onboarding checklist |

### Monitoring
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/health` | Active | No auth — Railway healthcheck |
| GET | `/launch-metrics` | Active | API key required |
| GET | `/stats` | Active | API key required |
| GET | `/performance` | Active | API key required |
| GET | `/timestamp` | Active | — |
| GET | `/` | Active | Heartbeat |

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
| Chat (free) | 24 hours | 20 per user | `/chat` |
| Chat (paid/trial) | 24 hours | 100 per user | `/chat` |

---

## 5. Security Measures Active at Launch

- **Helmet.js** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- **Rate limiting** — per-IP global + per-endpoint + per-user daily limits
- **API key auth** — `x-elemetric-key` header validated on all non-public endpoints
- **Input sanitisation** — null bytes + ASCII control chars stripped from all body/query params
- **Auth header hardening** — rejects malformed Authorization headers
- **CORS** — hardcoded production origins (elemetric.com.au, www.elemetric.com.au, app.elemetric.com.au, Railway URL) always allowed; additional origins via `ALLOWED_ORIGINS` env var; mobile apps (no Origin header) always pass through
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
- [ ] Verify CORS works for production domains (hardcoded: elemetric.com.au + Railway URL)

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

---

## 12. Changes — Mobile Testing Round (2026-03-17)

The following fixes were applied after initial mobile testing:

| # | Task | Change |
|---|------|--------|
| 1 | 360/wide_shot filter | `/review` now silently skips `photoType="360"` and `photoType="wide_shot"` photos. Use `/process-360` for 360 content. |
| 2 | PDF export fixed | `/export-report` generates a real server-side PDF using pdfkit. Returns `pdf_base64` + `Content-Type: application/pdf`. 1 KB size validation added. |
| 3 | Weather optional | `/weather-impact` no longer errors when `weatherCondition` is absent. Returns neutral zero-impact response. |
| 4 | Employer upgrade | New `POST /employer/upgrade` — updates role, creates team, sends welcome email. |
| 5 | Employer onboarding | New `GET /employer/onboarding-status` — powers the employer onboarding checklist. |
| 6 | Signature boundary | Documented explicitly: `/review` never requires signature. Signature is client-enforced before calling `/export-report`. |
| 7 | PDF retrieval | New `GET /pdf/:jobId` — regenerates and returns PDF for any past job by ID. |

**New dependency:** `pdfkit` added to `package.json`.

*This document was last updated 2026-03-17 (post-mobile-testing round).*

---

## 13. Changes — Session 3 (2026-03-18)

| # | Task | Change |
|---|------|--------|
| 1 | Referral code endpoint | New `GET /referral/generate-code` — idempotent, 60s cache, always returns a code |
| 2 | 14-day trial backend | `trial_started_at` column added to profiles (see `supabase/migrations/trial.sql`). New `POST /check-trial`. `/review` resolves user tier (free/trial/paid/employer) before rate limiting. Trial users get paid-tier limits (200/day). |
| 3 | Compliance chatbot | New `POST /chat` using Claude Haiku 4.5 (`claude-haiku-4-5-20251001`). Rate-limited: 20/day free, 100/day paid or active trial. Accepts `message` + `history[]` for multi-turn. |
| 4 | Employer web portal | 5 endpoints: `GET /employer/portal/:teamId`, `/employer/team/:teamId/jobs`, `/employer/team/:teamId/members`, `POST /employer/invite/web`, `GET /employer/report/:teamId` |
| 5 | AI speed optimization | prescreenPhotos() now uses `gpt-4o-mini` (faster/cheaper). Full analysis retains `gpt-4.1-mini`. Concurrency stays at 5. |
| 6–8 | Trade compliance prompts | Electrical (7 subtypes × 20 PASS/FAIL), Carpentry (7 subtypes), HVAC (5 subtypes) — all with detailed example calibration sets |
| 9 | Performance monitoring | `performanceStats` object tracks per-endpoint timing, error rates, job-type AI costs. `/launch-metrics` updated to surface these. |

**New dependencies:** `@anthropic-ai/sdk` added to `package.json`.

## 14. Changes — Session 5 (2026-03-20)

| # | Task | Change |
|---|------|--------|
| 1 | /review logging | Added STEP 1.5 Supabase connection log, plan/tier log, rate-limit pass confirmation. Full AI raw response logged in non-production mode. |
| 2 | BPC regulatory references | Plumbing prompt now cites specific versioned standards: AS/NZS 3500.1/3500.2/3500.3/3500.4:2025 + AS/NZS 5601.1:2022. VICTORIAN_REGULATIONS updated with clause references. PROMPT_REGISTRY version bumped to 1.2.0. |
| 3 | AI response quality | PROMPT_OPTIMISATION_HEADER now requires: specific AS/NZS clause numbers, exact measurements in failure descriptions, plain English with jargon explained, specific photo instructions in recommended_actions. |
| 4 | POST /compliance-summary | New endpoint — uses Claude Haiku to generate a plain-English job summary for property owners/building surveyors. Powers "Share with Client" feature. Returns `{ summary, outcome, confidence, risk_rating }`. |
| 5 | Rate limits | Updated: free=10/day, individual=50/day, employer=unlimited. Reset now uses Sydney midnight (AEST/AEDT). Improved 429 message tells user exactly when limit resets and how to upgrade. |
| 6 | /webhook/job-completed | Added `launchMetrics.jobsCompleted++` and `jobsCompletedWeek++` to the webhook (previously missing). |
| 7 | /verify-certificate HTML | Full redesign: ELEMETRIC header, large coloured VERIFIED/NOT VERIFIED/REVOKED badges, compliance score, risk rating colour-coded, suburb, date, licence last 4. Not-found and revoked pages also redesigned. |
| 8 | /chat system prompt | Expanded with: BPC/VBA/ESV roles, Victorian licence categories, 7-year liability context, VBA inspector visit checklist, common compliance failures by trade type, specific standard clause references. |
| 9 | /launch-metrics | Now returns: weekly counters (signups/analyses/PDFs/jobs this week), avg_confidence_today, most_popular_trade_today, error_rate_pct. New tracking added to review endpoint for confidence + trade type. |
| 10 | Final hardening | npm audit = 0 vulnerabilities. node --check = syntax clean. Docs updated. |

*This document was last updated 2026-03-20 (post-session-5).*
