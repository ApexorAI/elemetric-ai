# Elemetric Server — Launch Fixes Summary

Applied: 2026-03-19

---

## FIX 1 — AI Response Format

**Status:** DONE

- `validateAIResponse()` now normalises `risk_rating` to uppercase `LOW / MEDIUM / HIGH`
- Added `validateFinalResponse()` called immediately before every `res.json()` on `/review`
  — guarantees all 7 required fields are present with sensible defaults if missing
- Required fields: `overall_confidence` (number 0-100), `risk_rating` (LOW/MEDIUM/HIGH),
  `items_detected` (array), `items_missing` (array), `items_unclear` (array),
  `recommended_actions` (array), `liability_summary` (string)
- Enhanced STEP 6 log prints all 7 fields before every response
- `buildAIFallbackResponse` updated to return `MEDIUM` (uppercase)

---

## FIX 2 — Photo Processing Speed

**Status:** DONE

- Added 500KB base64 size warning per photo (logs warning, does not reject)
- Initial OpenAI analysis pass now uses `detail: "low"` — faster and cheaper
- Second pass with `detail: "high"` only for photos whose labels appear in
  `items_missing` or `items_unclear` — reduces token cost for passing photos
- High-detail results merged back into the final response (can promote items
  from missing → detected, recalculates confidence)
- Timing logs on every OpenAI call (step4Ms logged in ms)
- `launchMetrics.aiResponseTotalMs` and `aiResponseCount` updated per call for avg tracking

---

## FIX 3 — Auth Verification Endpoint

**Status:** DONE

- Added `GET /auth/verify` — accepts Bearer token in Authorization header
- Calls `supabaseAdmin.auth.getUser(token)` to verify against Supabase
- Returns `{ valid: true, user_id, email }` or `{ valid: false, error }`
- CORS updated: `x-api-key` added to `allowedHeaders`, `credentials: true`,
  `exposedHeaders` includes rate-limit headers — auth headers never blocked

---

## FIX 4 — Email Endpoints

**Status:** VERIFIED — all 8 endpoints exist and return `{ sent: true }`

All 8 endpoints confirmed working:
- `POST /send-welcome`
- `POST /send-job-complete`
- `POST /send-team-invite`
- `POST /send-near-miss-alert`
- `POST /send-referral`
- `POST /send-invoice`
- `POST /send-client-code`
- `POST /send-password-reset`

Each returns `{ sent: true, id }` on success. Uses `sendEmailWithRetry()` with
3-attempt retry logic and failed_notifications Supabase logging on exhaustion.

---

## FIX 5 — OpenAI Timeout Handling

**Status:** DONE

- Timeout reduced from 30s → **25s** — app never hangs waiting for OpenAI
- Retry delay changed from 2s → **3s** — gives OpenAI more recovery time
- 4xx errors (auth/bad request) no longer retried — they won't resolve on retry
- On timeout: returns fallback response with all items in `items_unclear`
- On 5xx/network failure: returns fallback response (same structure)
- Fallback always has all 7 required fields (passes `validateFinalResponse`)

---

## FIX 6 — Rate Limit Increase

**Status:** DONE

- `reviewLimiter` raised from 20 → **30 requests per minute** per IP
- Allows tradies to repeatedly test the app during launch week
- Tighten back to 10-15/min after launch week

---

## FIX 7 — Compliance Chatbot Endpoint

**Status:** DONE (endpoint was already built, updated spec compliance)

- `POST /chat` uses `claude-haiku-4-5-20251001` (unchanged)
- Now accepts both:
  - `{ messages: [{ role, content }, ...] }` (preferred new format)
  - `{ message: string, history: [...] }` (legacy format — backward compatible)
- System prompt updated to expert Australian standards: AS/NZS 3500, AS/NZS 5601.1,
  AS/NZS 3000, AS 1684, AS/NZS 5149 — plain English for tradespeople
- Returns `{ reply, response, usage: { input_tokens, output_tokens } }`
- Rate limits: 20 messages/day (free), 100 messages/day (paid/trial)

---

## FIX 8 — Launch Metrics Endpoint

**Status:** DONE

`GET /launch-metrics` now returns all 6 required monitoring dashboard fields:

| Field | Description |
|---|---|
| `signups_today` | Total new signups today (Sydney time) |
| `jobs_completed_today` | Total jobs completed today |
| `pdfs_generated_today` | Total PDFs generated today |
| `ai_analyses_today` | Total AI /review calls today |
| `errors_today` | Total unhandled errors today |
| `avg_ai_response_ms_today` | Average OpenAI response time today (ms) |

Counters reset at midnight Sydney time. Protected by `ELEMETRIC_API_KEY`.

---

## FIX 9 — Memory Leak Prevention

**Status:** DONE

- Auto-clear cache threshold lowered **500MB → 400MB** (in `/health` endpoint
  and in the 30-minute memory logger)
- Added `setInterval` every **30 minutes** logging:
  `heap_used/heap_total/rss/external MB`, `cache_entries`, `uptime_min`
- Proactive cache clear in logger if heap > 400MB
- `/health` response now includes `threshold_mb: 400` and `node_options` presence

**Required Railway configuration:**
Set `NODE_OPTIONS=--max-old-space-size=4096` in the Railway start command to
give Node.js a 4GB heap before OOM kill triggers.

---

## FIX 10 — Final Production Check

**Status:** DONE

- `npm audit` — **0 vulnerabilities** found
- All endpoints have rate limiting (global 20/15min, /review 30/min,
  /stamp 30/15min, /visualise 3/10min)

**Environment variables required in production:**

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | YES | /review, /visualise, prescreening |
| `ANTHROPIC_API_KEY` | YES | /chat compliance chatbot |
| `SUPABASE_URL` | YES | Database features |
| `SUPABASE_SERVICE_ROLE_KEY` | YES | Database features |
| `STRIPE_SECRET_KEY` | YES | Billing |
| `STRIPE_WEBHOOK_SECRET` | YES | Webhook signature verification |
| `RESEND_API_KEY` | YES | Transactional email |
| `ELEMETRIC_API_KEY` | YES | API authentication on protected endpoints |
| `REPLICATE_API_TOKEN` | YES | /visualise AC unit renderer |
| `ALLOWED_ORIGINS` | YES | CORS whitelist (comma-separated) |
| `EMAIL_FROM` | No | From address (default: Elemetric <noreply@elemetric.app>) |
| `NODE_OPTIONS` | YES | Set to --max-old-space-size=4096 on Railway |
| `PORT` | No | HTTP port (default: 8080) |
