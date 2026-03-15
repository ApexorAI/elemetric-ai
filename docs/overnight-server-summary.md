# Elemetric Server — Overnight Build Summary

**Date:** 15 March 2026
**Branch:** `main`
**Total commits this session:** 15 + prior sessions

---

## What Was Built

### Session 1 — Core Infrastructure (10 Tasks)

| # | Task | Endpoint / Feature |
|---|------|--------------------|
| 1 | Resend transactional email integration | `POST /send-invoice-email`, `POST /send-near-miss-alert`, `POST /send-welcome-email` |
| 2 | Victorian regulations knowledge base | `VICTORIAN_REGULATIONS` constant injected into all AI prompts via `buildRegulationsNote()` |
| 3 | AI response validation layer | `validateAIResponse()` — fills 7 required fields with safe defaults if AI omits them |
| 4 | SHA-256 in-memory analysis cache | 1-hour TTL, keyed by job type + image hashes; `getCacheKey()`, `getCached()`, `setCache()` |
| 5 | API usage monitoring | `usageStats` object tracking requests, OpenAI/Replicate/email costs; `GET /stats` |
| 6 | OpenAI retry + Replicate timeout message | `callOpenAIWithRetry()` — one retry after 2s; friendly timeout message for Replicate |
| 7 | Request deduplication | `pendingAnalyses` Promise-Map — duplicate requests within 10s await first result |
| 8 | Stripe webhook improvements | `payment_intent.payment_failed` and `customer.subscription.trial_will_end` email handling; masked email logging |
| 9 | `/property-passport` pagination | `page`/`limit` query params, max 20 per page, includes `pagination` metadata in response |
| 10 | Security audit | Helmet, CORS restriction, `express-rate-limit`, `escHtml()`, `isValidEmail()`, `isSafeUrl()`, null-byte input stripping |

---

### Session 2 — AI Training, Compliance Engine, and Endpoints (15 Tasks)

| # | Task | Description |
|---|------|-------------|
| 1 | Plumbing AI training examples | 15 PASS + 15 FAIL few-shot examples for GPT-4.1-mini plumbing prompt |
| 2 | Gas AI training examples | 15 PASS + 15 FAIL examples for gas fitting analysis |
| 3 | Electrical AI training examples | 15 PASS + 15 FAIL examples for electrical work |
| 4 | Drainage AI training examples | 15 PASS + 15 FAIL examples for drainage jobs |
| 5 | Carpentry AI training examples | 15 PASS + 15 FAIL examples for timber framing / structural carpentry |
| 6 | HVAC AI training examples | 15 PASS + 15 FAIL examples for split-system and ducted HVAC |
| 7 | Compliance scoring algorithm | `calculateComplianceScore()` — 4 dimensions (item coverage 40%, photo evidence 25%, regulatory compliance 20%, documentation 15%); returns grade A–F |
| 8 | Photo quality pre-screener | `prescreenPhotos()` — GPT-4.1-mini vision gate before main analysis; 422 returned if all photos fail; `photo_quality_flags` in response |
| 9 | Regulatory change monitoring | `REGULATORY_UPDATES` array (12 entries, 2023–2025); `GET /regulatory-updates` filterable by `jobType` and `severity` |
| 10 | Job risk assessment engine | `assessJobRisk()` — scores 6 dimensions, returns `overallRisk`, `liabilityYears`, `recommendedActions`; `POST /risk-assessment` |
| 11 | Victorian regulation checker | `checkVictorianCompliance()` with per-trade VIC checklists (plumbing 8, gas 8, electrical 8, drainage 6, carpentry 6, HVAC 6 requirements); `POST /compliance-check` |
| 12 | Stable Diffusion prompt rewrite | Photorealistic AC unit inpainting prompt with physical dimensions, product details, and expanded negative prompt; `guidance_scale` raised to 11, `num_inference_steps` to 60 |
| 13 | Supabase user-created webhook | `POST /webhook/user-created` — HMAC-verified, creates default profile row, sends welcome email to user, notifies cayde@elemetric.com.au |
| 14 | Analytics endpoint | `GET /analytics` — total users, jobs by type, avg confidence, top 10 missing items, geographic distribution, daily/weekly/monthly counts |
| 15 | Final security hardening | `stampLimiter` on `POST /stamp-photo` (30/15min); `/health` upgraded to check Supabase/OpenAI/Replicate/Resend connectivity; startup security report printed on server boot |

---

## Architecture Overview

```
index.js  (~3,300 lines)
│
├── Third-party clients
│   ├── OpenAI (GPT-4.1-mini vision)
│   ├── Replicate (Stable Diffusion inpainting)
│   ├── Stripe (billing webhooks)
│   ├── Supabase (service-role client)
│   └── Resend (transactional email)
│
├── Security middleware
│   ├── Helmet (HTTP headers)
│   ├── CORS restriction (ALLOWED_ORIGINS)
│   ├── express-rate-limit (global + per-route)
│   ├── API key auth (x-elemetric-key)
│   └── Input sanitisation (null-byte stripping)
│
├── AI pipeline (/review)
│   ├── Input validation + sanitisation
│   ├── Cache check (SHA-256 key, 1-hour TTL)
│   ├── Dedup check (Promise-Map, 10s window)
│   ├── Photo quality pre-screen (GPT-4.1-mini)
│   ├── Main compliance analysis (GPT-4.1-mini + VICTORIAN_REGULATIONS)
│   ├── Response validation (7 required fields)
│   ├── Compliance score calculation
│   ├── Cache + dedup resolve
│   └── Response
│
├── Analysis endpoints
│   ├── POST /review               — compliance photo analysis
│   ├── POST /visualise            — AC unit visualiser
│   ├── POST /stamp-photo          — GPS timestamp watermark
│   ├── POST /property-passport    — property compliance history
│   ├── POST /before-after         — before/after comparison
│   ├── POST /risk-assessment      — job risk profile
│   └── POST /compliance-check     — Victorian regulation checker
│
├── Email endpoints
│   ├── POST /send-invoice-email
│   ├── POST /send-near-miss-alert
│   └── POST /send-welcome-email
│
├── Webhook endpoints
│   ├── POST /webhook              — Stripe billing events
│   └── POST /webhook/user-created — Supabase auth signup
│
└── Read endpoints
    ├── GET /regulatory-updates
    ├── GET /analytics
    ├── GET /stats
    ├── GET /health
    ├── GET /timestamp
    └── GET /
```

---

## Key Technical Decisions

**Cache key strategy:** SHA-256 hash of `${type}|${label1}:${dataLen1}|...` — deterministic across identical uploads without storing raw image data in memory.

**Deduplication:** Promise-based Map so concurrent identical requests share one OpenAI call. The second request awaits the first's result, which is already cached by the time it resolves.

**Photo pre-screening placement:** Runs *after* dedup registration so duplicate requests benefit from the already-filtered image set without re-calling the screener.

**Compliance scoring formula:**
- Item coverage (40 pts): `detected / (detected + missing + unclear)`
- Photo evidence (25 pts): `min(photoCount / requiredCount, 1)`
- Regulatory markings (20 pts): keyword scan of detected items for AS/NZS standards, AGA, RCD, etc.
- Documentation (15 pts): GPS + signature + complexity penalty

**Risk assessment formula:** Additive risk points model — trade base risk (gas=4, electrical=4, plumbing=3) + compliance shortfalls + evidence gaps + time-decay for unresolved missing items.

**Victorian checklist evaluation:** Rule-based heuristics keyed to requirement category (certificate filing, permit, test record, evidence keyword scan) — backward-compatible with existing `/review` response schema.

---

## Environment Variables Required

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENAI_API_KEY` | GPT-4.1-mini vision | Yes |
| `REPLICATE_API_TOKEN` | Stable Diffusion inpainting | Yes (for /visualise) |
| `SUPABASE_URL` | Database connection | Yes |
| `SUPABASE_SERVICE_KEY` | Service-role DB access | Yes |
| `STRIPE_SECRET_KEY` | Billing events | Yes |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification | Yes |
| `RESEND_API_KEY` | Transactional email | Yes |
| `EMAIL_FROM` | Sender address | Optional (default: `Elemetric <noreply@elemetric.app>`) |
| `ELEMETRIC_API_KEY` | API authentication | Yes (production) |
| `ALLOWED_ORIGINS` | CORS whitelist (comma-separated) | Yes (production) |
| `SUPABASE_WEBHOOK_SECRET` | user-created webhook verification | Yes |
| `PORT` | Server port | Optional (default: 8080) |

---

## New Endpoints Quick Reference

### `POST /risk-assessment`
```json
{
  "jobType": "plumbing",
  "complianceScore": 72,
  "missingItemCount": 3,
  "gpsRecorded": false,
  "signatureObtained": false,
  "photosTaken": 4,
  "requiredPhotos": 8,
  "complexityScore": 6,
  "daysSinceCompletion": 5
}
```
Returns: `overallRisk`, `riskPoints`, `riskFactors`, `recommendedActions`, `liabilityYears`, `summary`

---

### `POST /compliance-check`
```json
{
  "jobType": "electrical",
  "itemsDetected": ["RCD protection installed", "circuit schedule updated"],
  "itemsMissing": ["earth continuity test record"],
  "certificateFiled": false,
  "permitObtained": true,
  "testRecorded": false
}
```
Returns: `overallStatus`, `score`, `criticalFailures`, `results[]` (per-requirement pass/fail/uncertain)

---

### `GET /regulatory-updates?jobType=plumbing&severity=critical`
Returns updates from the last 12 months, filterable by trade type and severity level.

---

### `GET /analytics`
Returns: user totals, job counts (daily/weekly/monthly), avg confidence, top missing items, geographic distribution.

---

### `POST /webhook/user-created`
Supabase Auth hook payload (`{ record: { id, email, raw_user_meta_data } }`).
Verify with `x-supabase-webhook-secret` header matching `SUPABASE_WEBHOOK_SECRET`.

---

*Generated automatically after completing all 15 overnight build tasks.*
