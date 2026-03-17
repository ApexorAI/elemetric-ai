# Wednesday 2026-03-17 — Server Development Summary

All 15 tasks completed in one session. Summary of changes below.

---

## Task 1 — Memory leak prevention & monitoring

**What:** Added 30-minute memory monitoring interval, GC hints at 400MB, and graceful shutdown handler.

**Key features:**
- `setInterval` logs `heap`, `rss`, `cache`, `pending`, `clientSessions`, `userDailyUsage` every 30 min
- Auto-evicts oldest 1000+ entries from all in-memory Maps
- GC hint via `global.gc()` when heap exceeds 400MB (requires `--expose-gc`)
- `SIGTERM` + `SIGINT` handlers clear all caches cleanly before exit

---

## Task 2 — Controlled exposure / stage system

**New endpoints:**
- `POST /user/stage` — returns current stage (1/2/3) based on jobs completed, auto-upgrades
- `POST /user/unlock-stage` — manual stage unlock with reason
- `GET /user/tools` — available + locked tools for current stage

**SQL migration:** `supabase/migrations/user_stages.sql`

**Stage thresholds:** Stage 1 = 0 jobs, Stage 2 = 5 jobs, Stage 3 = 20 jobs

---

## Task 3 — Referral tracking polish

**New endpoints:**
- `POST /referral/verify` — validate a referral code before signup

**Stripe webhook update:** On `customer.subscription.updated` with `status=active`, checks invoice count. If ≥2 paid invoices, auto-completes the referral with 20% commission.

---

## Task 4 — Client portal security hardening

**Changes:**
- `clientVerifyLimiter`: 3 attempts per IP+email per hour
- `/client/verify`: now uses `clientVerifyLimiter`, code expiry extended to 15 minutes
- Audit logging to `client_portal_audit` table on verify request and access grant

**SQL migration:** `supabase/migrations/client_portal_audit.sql`

---

## Task 5 — Timesheet payroll calculations

**New functions:**
- `isPublicHoliday(dateStr)` — checks Victorian public holidays 2025-2026
- `calcTimesheetPay(clockIn, clockOut, hourlyRate, allowances)` — full pay calc

**Pay rules:**
- Ordinary day: 8 hours at base rate
- Overtime (daily): >8 hours at 1.5x
- Saturday: 1.5x rate
- Sunday: 2.0x rate
- Victorian public holidays: 2.5x rate
- Allowances: travel, tools, site (added on top)

**New endpoint:** `POST /timesheet/payslip` — full weekly payslip with 38hr/week OT threshold

**Updated:** `/timesheet/clock-out` now uses `calcTimesheetPay()` and stores `overtime_hours`, `overtime_pay`, `rate_multiplier`, `is_public_holiday`, `total_allowances`

---

## Task 6 — Quote to invoice conversion

**New endpoint:** `POST /quote/convert-to-invoice` — copies all line items from a quote to a new draft invoice, marks quote as `converted`

**Updated:** `PUT /quote/accept` now returns `next_step` hint in response

**Workflow:** Quote → Accepted → Job Scheduled → Job Complete → Invoice

---

## Task 7 — Regulatory alerts automation

**New functions:**
- `scheduleSundayCheck()` — calculates ms until next Sunday midnight AEDT, runs weekly
- `checkRegulatoryNotifications()` — finds affected users, emails once, logs to DB

**New endpoint:** `GET /regulatory-updates/affected-jobs` — jobs affected by regulatory changes for a specific user

**SQL migration:** `supabase/migrations/regulatory_notifications.sql`

---

## Task 8 — Analytics aggregation with caching

**New globals:** `analyticsAggregateCache`, `ANALYTICS_CACHE_TTL` (1 hour), `propertyPassportCache`, `PROPERTY_CACHE_TTL` (24 hours)

**New endpoint:** `POST /analytics/aggregate` — pre-computed employer analytics (84 days):
- Jobs by trade type
- Average confidence by trade type
- Top 10 missing items
- Weekly job counts (12 weeks)
- 1-hour cache, `forceRefresh` param to bypass

**Background:** Hourly interval clears all cached analytics entries

---

## Task 9 — Webhook/notification reliability

**New function:** `sendEmailWithRetry(to, subject, html, options)` — 3 attempts with 1min/5min/15min delays. Logs to `failed_notifications` on total failure.

**New endpoints:**
- `GET /notifications/failed` — list unresolved failed notifications
- `POST /notifications/retry` — manually retry a failed notification

**SQL migration:** `supabase/migrations/failed_notifications.sql`

---

## Task 10 — API documentation

**New file:** `docs/api-reference.md`

Coverage: Analysis, Photo Stamping, Certificate Verification, Regulatory Updates, User Stage System, Referral System, Timesheets, Quotes, Analytics, Client Portal, Subcontractors, Property Passport, Notifications, Performance, Health & Status.

---

## Task 11 — Response time logging

**New globals:** `performanceLogs[]` (max 1000), `SLOW_ENDPOINT_THRESHOLD_MS` (2000ms)

**Middleware:** `app.use()` on every request — logs method, path, status, ms to `performanceLogs`

**Console warning** when any endpoint exceeds 2000ms

**New endpoint:** `GET /performance` — aggregated avg/max/error count per endpoint, sorted slowest-first

---

## Task 12 — Certificate verification HTML page

**Updated:** `GET /verify-certificate`

- Checks `Accept: text/html` header
- Returns branded navy/orange HTML page with compliance badge (PASS/CONDITIONAL/FAIL) when accessed from a browser
- HTML responses for not-found and revoked states too
- JSON response unchanged for API clients

---

## Task 13 — Subcontractor compliance monitoring

**New endpoints:**
- `GET /subcontractor/compliance-summary` — licence/insurance status + Elemetric job scores for all active subs
- `POST /subcontractor/request-report` — emails sub requesting compliance documentation

**Background job:** `scheduleWeeklySubcontractorEmail()` — Monday 8am AEDT, emails employers about subs with documents expiring within 30 days

---

## Task 14 — Property passport enhancement

**Updated:** `GET /property-passport`
- Added `compliance_grade` (A/B/C/D based on average confidence)
- Added `trade_history` (unique trade types seen at address)
- 24-hour in-memory cache for page 1 results

**New endpoint:** `POST /property-passport/claim` — property owner registers for notifications, confirmation email sent

---

## Task 15 — Final pre-launch audit

**npm audit:** 0 vulnerabilities

**Updated:** Startup security report in `app.listen` callback — 30+ new endpoints listed

**New files:**
- `docs/server-launch-ready.md` — production readiness checklist
- `docs/wednesday-server-summary.md` — this file

---

## SQL Migrations Created Today

| File | Table |
|------|-------|
| `user_stages.sql` | `user_stages` |
| `client_portal_audit.sql` | `client_portal_audit` |
| `regulatory_notifications.sql` | `regulatory_notifications` |
| `failed_notifications.sql` | `failed_notifications` |

---

## Endpoints Added Today

| Method | Path | Task |
|--------|------|------|
| POST | /user/stage | 2 |
| POST | /user/unlock-stage | 2 |
| GET | /user/tools | 2 |
| POST | /referral/verify | 3 |
| POST | /timesheet/payslip | 5 |
| POST | /quote/convert-to-invoice | 6 |
| GET | /regulatory-updates/affected-jobs | 7 |
| POST | /analytics/aggregate | 8 |
| GET | /notifications/failed | 9 |
| POST | /notifications/retry | 9 |
| GET | /performance | 11 |
| GET | /subcontractor/compliance-summary | 13 |
| POST | /subcontractor/request-report | 13 |
| POST | /property-passport/claim | 14 |

Total new endpoints: **14**
