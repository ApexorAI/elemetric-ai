# Elemetric Server — Production Certificate

**Version:** Session 6 (2026-03-21)
**Status:** PRODUCTION READY
**Jurisdiction:** Victoria, Australia

---

## Verification Checklist

This document certifies that all items below have been verified before deploying the Elemetric server to production.

### 1. Security

| Item | Status | Notes |
|------|--------|-------|
| `npm audit` clean (0 high/critical) | PASS | Last run: 2026-03-21 |
| Helmet middleware active | PASS | All security headers enforced |
| CORS restricted to known origins | PASS | `elemetric.com.au`, `www.elemetric.com.au`, `app.elemetric.com.au`, Railway URL hardcoded |
| API key auth on all sensitive endpoints | PASS | `apiKeyAuth` middleware on all non-public routes |
| Rate limiting active | PASS | Global 20/15min, `/review` 30/min, `/stamp-photo` 30/15min, `/visualise` 3/10min |
| Input sanitisation | PASS | Null-byte and control-char stripping on all user inputs |
| SQL injection prevention | PASS | All DB queries via Supabase client (parameterised) |
| No secrets in source code | PASS | All secrets via environment variables |
| Stripe webhook signature verified | PASS | `STRIPE_WEBHOOK_SECRET` required |

### 2. Environment Variables

All required variables must be set in Railway before deploying.

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | REQUIRED | GPT-4.1-mini vision for `/review` and prescreening |
| `ANTHROPIC_API_KEY` | REQUIRED | Claude Haiku 4.5 for `/chat` and `/compliance-summary` |
| `SUPABASE_URL` | REQUIRED | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | REQUIRED | Supabase service role key (bypasses RLS) |
| `ELEMETRIC_API_KEY` | REQUIRED | Master API key for authenticated endpoints |
| `RESEND_API_KEY` | REQUIRED | Transactional email (welcome, job complete, invoices) |
| `STRIPE_SECRET_KEY` | REQUIRED | Stripe billing |
| `STRIPE_WEBHOOK_SECRET` | REQUIRED | Stripe webhook signature verification |
| `REPLICATE_API_TOKEN` | REQUIRED | Stable Diffusion for `/visualise` |
| `EMAIL_FROM` | OPTIONAL | Sender address (default: `Elemetric <noreply@elemetric.com.au>`) |
| `ALLOWED_ORIGINS` | OPTIONAL | Extra CORS origins (hardcoded defaults cover production) |
| `NODE_OPTIONS` | RECOMMENDED | Set `--max-old-space-size=4096` in Railway start command |

### 3. AI / Model Configuration

| Item | Status | Notes |
|------|--------|-------|
| Photo analysis: GPT-4.1-mini | PASS | `gpt-4.1-mini` with vision, 30s timeout + fallback |
| Prescreening: GPT-4o-mini | PASS | Parallel prescreening via `withConcurrency(items, 5, fn)` |
| Chatbot: Claude Haiku 4.5 | PASS | `claude-haiku-4-5-20251001`, 1024 token max |
| PROMPT_OPTIMISATION_HEADER | PASS | Victorian regulatory context, BPC/VBA/ESV, AS/NZS clause refs |
| Standards references updated | PASS | All prompts reference `:2025` editions of AS/NZS 3500 series |
| Gas standard updated | PASS | `AS/NZS 5601.1:2022` (not `:2013`) throughout |

### 4. Rate Limiting & Quotas

| Tier | Daily Analyses | Notes |
|------|---------------|-------|
| Free | 10/day | Reset at Sydney midnight (AEST/AEDT) |
| Individual | 50/day | Reset at Sydney midnight |
| Employer | Unlimited | No daily cap |

### 5. Endpoints — Production Checklist

#### Core AI Endpoints
- [x] `POST /review` — AI compliance photo analysis (rate limited, prescreening, Supabase log)
- [x] `POST /compliance-summary` — Claude-powered compliance narrative summary
- [x] `POST /stamp-photo` — GPS + timestamp watermark
- [x] `POST /export-report` — PDFKit compliance report with regulatory notices section
- [x] `GET /verify-certificate` — Public certificate verification (HTML + JSON)

#### Communication
- [x] `POST /send-welcome` — Welcome email
- [x] `POST /send-job-complete` — Job completion email with compliance summary, risk rating, missing items, 7-year liability reminder
- [x] `POST /send-team-invite` — Team invitation email
- [x] `POST /send-invoice` — Invoice email with PDF link

#### Quote & Invoice Workflow
- [x] `POST /quote/create` — Create quote with line items, GST calculation
- [x] `GET /quote/list` — List quotes by userId/status/customerId
- [x] `GET /quote/:id` — Fetch single quote
- [x] `PUT /quote/accept` — Accept quote, create linked job
- [x] `POST /quote/convert-to-invoice` — Convert accepted quote to invoice
- [x] `GET /invoice/list` — List invoices
- [x] `GET /invoice/:id` — Fetch single invoice
- [x] `PUT /invoice/mark-paid` — Mark paid, send payment receipt email

#### Regulatory & Compliance Reference
- [x] `GET /regulatory-updates` — Full AS/NZS change history (filterable)
- [x] `GET /regulatory-alerts` — Active alerts requiring immediate attention
- [x] `POST /push-subscription/register` — Register Web Push subscription
- [x] `GET /compliance-tips` — 3 seasonal Victorian compliance tips (current month)
- [x] `GET /compliance-tips/:jobType` — Trade-specific compliance tips

#### Analytics & Monitoring
- [x] `GET /launch-metrics` — Launch day counters (API key required)
- [x] `GET /performance` — p95, slowest/fastest endpoints, error rates
- [x] `GET /health` — Service connectivity check
- [x] `GET /` — Heartbeat

### 6. Memory & Performance

| Item | Status | Notes |
|------|--------|-------|
| Memory leak prevention | PASS | 400MB threshold, 30-min memory logging |
| LRU cache | PASS | 100 entries max, 1-hour TTL |
| Concurrent AI calls capped | PASS | `withConcurrency(items, 5, fn)` |
| Startup time warning | PASS | Warns if startup > 5000ms |
| p95 tracking | PASS | Per-endpoint p95 in `/performance` |
| Photo prescreening | PASS | Fails clearly irrelevant photos before full AI call |

### 7. Regulatory Standards — Final Verification

All AI prompts and compliance logic reference the following current standards as of this certificate date:

| Trade | Standard | Edition | Status |
|-------|----------|---------|--------|
| Plumbing (water) | AS/NZS 3500.1 | 2025 | CURRENT |
| Plumbing (drainage) | AS/NZS 3500.2 | 2025 | CURRENT |
| Plumbing (stormwater) | AS/NZS 3500.3 | 2025 | CURRENT |
| Plumbing (heated water) | AS/NZS 3500.4 | 2025 | CURRENT |
| Gas installations | AS/NZS 5601.1 | 2022 | CURRENT |
| Electrical wiring | AS/NZS 3000 | 2018 + Amd 2 | CURRENT |
| Timber framing | AS 1684.2 | 2010 | CURRENT |
| HVAC refrigeration | AS/NZS 5149 series | — | CURRENT |
| HVAC ventilation | AS/NZS 1668.2 | — | CURRENT |
| TMV/mixing valves | AS/NZS 4032.1 | — | CURRENT |
| PTR/pressure relief | AS 1357 / AS 1357.2 | — | CURRENT |

### 8. Launch Readiness — Final Sign-Off

| Category | Pass |
|----------|------|
| Security audit (npm audit clean) | YES |
| All required env vars documented | YES |
| AI prompts reference current standards | YES |
| Rate limiting enforced on all tiers | YES |
| Certificate verification page live | YES |
| Email delivery tested (Resend) | YES |
| Supabase RLS policies reviewed | YES |
| PDF generation tested | YES |
| Startup time < 5000ms confirmed | YES |
| Memory limits configured in Railway | YES |

---

## Session Changelog

| Session | Date | Key Changes |
|---------|------|-------------|
| Session 1 | 2026-03-01 | Initial server — `/review`, `/chat`, `/health`, Supabase integration |
| Session 2 | 2026-03-05 | Electrical/carpentry/HVAC prompts, quote/job workflow, employer portal |
| Session 3 | 2026-03-08 | Property Passport, weatherproof stamping, before/after photos |
| Session 4 | 2026-03-12 | CORS hardening, 14-day trial backend, auto-trial in `/review`, risk_rating case fix |
| Session 5 | 2026-03-15 | BPC standards in prompts, `/compliance-summary`, rate limits, `/launch-metrics` weekly counters, `/verify-certificate` redesign |
| Session 6 | 2026-03-21 | Victorian regulatory context + AS/NZS clause refs in all prompts, `/send-job-complete` enhanced, quote/invoice workflow completed, `/verify-certificate` improved, `REGULATORY_ALERTS`, p95 performance benchmarking, seasonal compliance tips |

---

## Known Limitations

- `POST /push-subscription/register` stores subscriptions in-memory (cleared on restart). For production persistence, ensure the `push_subscriptions` table exists in Supabase and the upsert succeeds on first registration.
- `GET /visualise` requires `REPLICATE_API_TOKEN` and `OPENAI_API_KEY`. If Replicate is unavailable the endpoint returns 503 gracefully.
- The `training_mode`, `floor_plan_enabled`, and `wide_shot_enabled` feature flags are set to `false` for launch and must be manually re-enabled in `FEATURE_FLAGS` when those features ship.
- Startup time on Railway cold starts may occasionally exceed 5000ms if the dyno is being provisioned fresh — this is expected and non-critical.

---

*Certified by: Elemetric engineering team — 2026-03-21*
*Next review: After first 500 production jobs are processed*
