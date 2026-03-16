# Tuesday Server Session Summary

**Date:** 2026-03-17
**Tasks completed:** 10
**Commits:** 10
**npm audit:** 0 vulnerabilities

---

## Task 1 — Referral System

**Endpoints:**
- `POST /referral/generate` — Input: `{ userId }` → Output: `{ referral_code, existing, referral_url }`
- `POST /referral/track` — Input: `{ referralCode, referredUserId }` → Output: `{ tracked, referral_id }`
- `POST /referral/complete` — Input: `{ referredUserId, planAmount }` → Output: `{ completed, commission_aud, referral_id }` + sends commission email via Resend
- `GET /referral/stats?userId=` → Output: `{ referral_code, referral_url, total_referrals, signed_up, completed, total_earned_aud, referrals[] }`
- `GET /referral/leaderboard` → Output: `{ leaderboard[{ rank, referrals, earned_aud, display_name }] }`

**SQL Migration:** `supabase/migrations/referrals.sql`
- Table: `referrals` (id, referrer_id, referred_id, code, status, commission_aud, timestamps)
- Adds columns to `profiles`: `referral_code`, `referred_by`, `total_referral_earnings_aud`
- RLS enabled

---

## Task 2 — Client Portal

**Endpoints:**
- `POST /client/verify` — Input: `{ email, address }` → Sends 6-digit code, checks job_analyses for address. Output: `{ sent, message }`
- `POST /client/access` — Input: `{ email, address, code }` → Output: `{ session_token, expires_in: 3600 }`
- `GET /client/reports` (header: `x-client-token`) → Output: `{ address, reports[{ job_id, job_type, date, compliance_score, risk_rating, suburb, items_detected_count, items_missing_count }] }`
- `GET /client/certificate/:jobId` (header: `x-client-token`) → Output: `{ certificate: { job_id, job_type, address, compliance_score, items_detected, items_missing, liability_summary, verified_at } }`

**In-memory stores:** `clientSessions` (1hr TTL), `clientVerifyCodes` (10min TTL) — cleaned every 15 minutes

---

## Task 3 — Subcontractor Management

**Endpoints:**
- `POST /subcontractor/add` (apiKeyAuth) — Input: `{ employerId, fullName, email, phone, abn, licenceNumber, licenceType, licenceExpiry, insuranceProvider, insurancePolicyNumber, insuranceExpiry, tradeTypes[] }` → Output: `{ subcontractor }`
- `GET /subcontractor/list?employerId=&status=` (apiKeyAuth) → Output: `{ subcontractors[{ ...fields, licence_expiring_soon, insurance_expiring_soon }], total }`
- `PUT /subcontractor/update` (apiKeyAuth) — Input: `{ subcontractorId, employerId, ...fields }` → Output: `{ subcontractor }`
- `DELETE /subcontractor/remove` (apiKeyAuth) — Input: `{ subcontractorId, employerId }` → Soft-deletes (sets status=inactive). Output: `{ removed: true }`
- `POST /subcontractor/check-expiry` (apiKeyAuth) — Input: `{ employerId }` → Emails each subcontractor with expiring docs (within 30 days). Output: `{ alerts_sent, alerts[] }`

**SQL Migration:** `supabase/migrations/subcontractors.sql`
- Table: `subcontractors` with full licence and insurance fields, trade_types array, status enum, RLS enabled

---

## Task 4 — Benchmark (updated)

**Endpoint:** `GET /benchmark?userId=&jobType=&suburb=`

**Output:**
```json
{
  "sample_size": 1234,
  "overall": { "average": 78, "median": 80, "p25": 65, "p75": 88, "p90": 94 },
  "trade_type_benchmarks": { "plumbing": { "average": 76, "sample_size": 400, "percentile_75": 85 } },
  "suburb_context": { "suburb": "Richmond", "average": 82, "sample_size": 23 },
  "improvement_velocity": { "median_90_day_gain": 8, "sample_size": 120 },
  "user": { "score": 85, "percentile": 72, "job_count": 14 },
  "motivational_message": "...",
  "generated_at": "..."
}
```

Uses real Supabase data from `job_analyses` table (last 90 days). Adds user percentile, suburb context, 12-trade breakdown, and improvement velocity.

---

## Task 5 — Training Mode

**Endpoint:** `POST /training`

**Input:** `{ image (base64), mime, jobType, checklistItem, userId }`

**Output:**
```json
{
  "training_score": 7,
  "what_photo_shows_correctly": "...",
  "what_to_improve": "...",
  "perfect_photo_description": "...",
  "regulation_reference": "AS/NZS 3500.4 Clause 4.2.3",
  "tips": ["tip1", "tip2", "tip3"],
  "ready_for_real_job": false
}
```

Uses GPT-4o-mini with vision. Stores to `training_submissions` table separately from compliance records (does not affect compliance scores).

**SQL Migration:** `supabase/migrations/training.sql`

---

## Task 6 — Timesheets

**Endpoints:**
- `POST /timesheet/clock-in` — Input: `{ userId, employerId?, jobId?, location?, hourlyRate?, notes? }` → Auto-closes any existing open session. Output: `{ timesheet, clocked_in_at }`
- `POST /timesheet/clock-out` — Input: `{ userId, timesheetId? }` → Calculates total_hours and total_pay. Output: `{ timesheet, total_hours, total_pay }`
- `GET /timesheet/current?userId=` → Output: `{ clocked_in: true|false, timesheet?, elapsed_hours? }`
- `GET /timesheet/history?userId=&limit=&offset=` → Output: `{ timesheets[], total }`
- `GET /timesheet/summary?userId=&startDate=&endDate=` → Output: `{ period, total_sessions, total_hours, total_pay_aud, job_breakdown{}, csv_export }`

**SQL Migration:** `supabase/migrations/timesheets.sql`
- Table: `timesheets` (clock_in, clock_out, total_hours, total_pay, hourly_rate, status enum open/closed), RLS enabled

---

## Task 7 — Regulatory Updates (updated)

**Endpoint:** `GET /regulatory-updates?jobType=&userId=&since=&severity=`

Updated `REGULATORY_UPDATES` array with 11 entries including 10 real AS/NZS updates 2020-2025:
- AS/NZS 3500 (2021) — tempering valve 45°C for vulnerable persons
- AS/NZS 3000 (2020) — RCD all circuits
- AS/NZS 5601.1 (2022) — gas appliance clearances
- NCC 2022 — WELS flow rates
- AS/NZS 3500.2 (2021) — trap seal depths
- VBA Practice Note (2022) — HWS photo documentation
- AS 1684 (2022) — wind load tables
- AS 4254.2 (2023) — ductwork sealing
- ESV EV Charger (2024) — smart charger declaration
- NCC 2025 — BESS DC isolation

**Output:** `{ updates[], total, allCount, asOf, user_affected_summaries[] }`

If `userId` provided, cross-references user's job history to identify which updates affect their past work.

---

## Task 8 — Employer Analytics

**Endpoints:**
- `GET /employer/analytics/overview?employerId=` (apiKeyAuth) → `{ total_jobs_all_time, jobs_this_week, jobs_this_month, average_compliance_*, high_risk_jobs_all_time, active_plumbers }`
- `GET /employer/analytics/trends?employerId=` (apiKeyAuth) → `{ weekly_trends[{ week, jobs, average }], weeks: 12 }`
- `GET /employer/analytics/failures?employerId=&limit=` (apiKeyAuth) → `{ top_failures[{ item, occurrences }], total_jobs_analysed }`
- `GET /employer/analytics/plumber/:id?employerId=` (apiKeyAuth) → `{ name, total_jobs, average_compliance, trend, high_risk_jobs, top_missed_items[], recent_jobs[] }`
- `GET /employer/analytics/export?employerId=&month=` (apiKeyAuth) → CSV file download (Content-Disposition: attachment)

---

## Task 9 — Tradify Feature Parity

**Endpoints:**
- `POST /quote/create` (apiKeyAuth) — Input: `{ userId, customerId?, jobType, description, lineItems[{ qty, unitPrice, description }], notes, validDays }` → Calculates subtotal, GST (10%), total. Output: `{ quote }`
- `GET /quote/list?userId=&status=&customerId=` (apiKeyAuth) → `{ quotes[] }`
- `PUT /quote/accept` (apiKeyAuth) — Input: `{ quoteId, userId }` → Updates quote status, creates linked job record. Output: `{ quote, job }`
- `POST /job/schedule` (apiKeyAuth) — Input: `{ userId, jobId, scheduledDate, scheduledTime?, notes?, assignedTo? }` → Output: `{ job }`
- `GET /job/calendar?userId=&startDate=&endDate=` (apiKeyAuth) → `{ calendar[] }`
- `POST /customer/create` (apiKeyAuth) — Input: `{ userId, name, email?, phone?, address?, suburb?, notes? }` → Output: `{ customer }`
- `GET /customer/list?userId=&search=` (apiKeyAuth) → `{ customers[{ ...fields, job_count }] }`
- `POST /job/cost` (apiKeyAuth) — Input: `{ labourHours, labourRate, materials[{ qty, unitCost }], overheadPercent=15, marginPercent=20 }` → Output: `{ labour_cost, materials_cost, overhead, margin, subtotal_ex_gst, gst, total_inc_gst }`

---

## Task 10 — Production Hardening

- `npm audit`: **0 vulnerabilities**
- All new endpoints follow consistent error handling patterns
- SQL migrations created for all new tables
- Docs updated: `production-ready.md`, `tuesday-server-summary.md`

---

## SQL Migrations Summary

| File | Tables | Notes |
|---|---|---|
| `referrals.sql` | `referrals` | RLS, adds columns to `profiles` |
| `subcontractors.sql` | `subcontractors` | RLS, full licence/insurance tracking |
| `training.sql` | `training_submissions` | Separate from compliance records |
| `timesheets.sql` | `timesheets` | RLS, clock-in/out with pay calculation |

All migrations in `C:/Users/cayde/Projects/elemetric/server/supabase/migrations/`.
