# Elemetric API Reference

Base URL: `https://api.elemetric.app` (or your Railway deployment URL)

## Authentication

Most endpoints require an API key in the `x-api-key` header:

```
x-api-key: YOUR_ELEMETRIC_API_KEY
```

Client portal endpoints use the `x-client-token` header (obtained from `/client/access`).

---

## Analysis

### POST /review
Analyse job photos for compliance issues.

**Auth:** API key required

**Request:**
```json
{
  "userId": "uuid",
  "jobType": "plumbing",
  "images": [
    { "label": "before", "url": "https://..." },
    { "label": "after",  "url": "https://..." }
  ],
  "suburb": "Richmond",
  "address": "123 Smith St Richmond VIC 3121"
}
```

**Response:**
```json
{
  "job_id": "uuid",
  "overall_confidence": 87,
  "items_present": ["isolation valve", "pressure test"],
  "items_missing": ["compliance plate"],
  "risk_rating": "low",
  "summary": "Installation meets AS/NZS 3500 requirements...",
  "recommendations": ["Attach compliance plate before handover"]
}
```

---

### POST /review-stream
Same as `/review` but streams the response via Server-Sent Events for real-time display.

**Auth:** API key required

**Request:** Same as `/review`

**Response:** `text/event-stream` — each `data:` chunk is a partial JSON token.

---

### POST /process-360
Analyse a 360-degree panoramic photo for full-room compliance.

**Auth:** API key required

**Request:**
```json
{
  "userId": "uuid",
  "jobType": "hvac",
  "imageUrl": "https://...",
  "address": "123 Smith St"
}
```

**Response:**
```json
{
  "job_id": "uuid",
  "overall_confidence": 82,
  "panoramic_zones": ["ceiling", "walls", "floor"],
  "zone_analysis": { "ceiling": "Pass", "walls": "Conditional" },
  "summary": "360° analysis complete..."
}
```

---

### POST /training
Run a job analysis in training mode — does not persist to database.

**Auth:** API key required

**Request:** Same structure as `/review`

**Response:**
```json
{
  "training": true,
  "overall_confidence": 75,
  "items_present": [...],
  "items_missing": [...],
  "feedback": "Good attempt — remember to capture...",
  "score": 75
}
```

---

## Photo Stamping

### POST /stamp-photo
Add GPS coordinates and timestamp watermark to a job photo.

**Auth:** API key required

**Rate limit:** 30 requests / 15 minutes

**Request (multipart/form-data):**
- `photo` — image file (JPEG or PNG)
- `userId` — string
- `latitude` — float
- `longitude` — float
- `address` — string (optional)
- `jobType` — string (optional)

**Response:** Returns the stamped image as `image/jpeg`.

---

## Certificate Verification

### GET /verify-certificate
Verify the authenticity of an Elemetric compliance certificate.

**Auth:** None required (public endpoint)

**Query params:**
- `id` — certificate ID (UUID)

**Response (JSON):**
```json
{
  "genuine": true,
  "revoked": false,
  "certificate_id": "uuid",
  "job_type": "plumbing",
  "job_date": "2026-03-15",
  "suburb": "Richmond",
  "overall_compliance_result": "PASS",
  "confidence_band": "high",
  "risk_rating": "low",
  "plumber_licence_last4": "1234",
  "verified_at": "2026-03-17T00:00:00.000Z",
  "message": "This is a genuine Elemetric compliance certificate."
}
```

**HTML response:** When called from a browser (`Accept: text/html`), returns a branded verification page with compliance badge.

---

## Regulatory Updates

### GET /regulatory-updates
List all known regulatory updates and their details.

**Auth:** None required

**Response:**
```json
{
  "updates": [
    {
      "id": "as3500-2021",
      "standard": "AS/NZS 3500",
      "title": "Plumbing and drainage — updated requirements",
      "effectiveDate": "2021-07-01",
      "severity": "high",
      "affectsJobTypes": ["plumbing"],
      "summary": "...",
      "actionRequired": "..."
    }
  ],
  "total": 1
}
```

---

### GET /regulatory-updates/affected-jobs
Returns a user's jobs that are affected by regulatory changes.

**Auth:** None (userId in query)

**Query params:**
- `userId` — string (required)

**Response:**
```json
{
  "user_id": "uuid",
  "affected_update_count": 2,
  "updates": [
    {
      "update_id": "as3500-2021",
      "standard": "AS/NZS 3500",
      "title": "...",
      "effective_date": "2021-07-01",
      "severity": "high",
      "action_required": "...",
      "affected_jobs": [
        { "id": "uuid", "type": "plumbing", "date": "2020-06-15", "suburb": "Richmond", "score": 82 }
      ]
    }
  ]
}
```

---

## User Stage System

### POST /user/stage
Get the user's current stage and job count. Auto-upgrades stage if eligible.

**Auth:** None

**Request:**
```json
{ "userId": "uuid" }
```

**Response:**
```json
{
  "user_id": "uuid",
  "current_stage": 2,
  "jobs_completed": 7,
  "next_stage": 3,
  "jobs_until_next_stage": 13,
  "stage_thresholds": { "1": 0, "2": 5, "3": 20 }
}
```

---

### POST /user/unlock-stage
Manually unlock a stage for a user (admin use).

**Auth:** None

**Request:**
```json
{
  "userId": "uuid",
  "stage": 3,
  "reason": "Admin override"
}
```

**Response:**
```json
{
  "unlocked": true,
  "user_id": "uuid",
  "stage": 3,
  "reason": "Admin override"
}
```

---

### GET /user/tools
Returns tools available for the user's current stage, plus locked tools.

**Auth:** None

**Query params:**
- `userId` — string (required)

**Response:**
```json
{
  "user_id": "uuid",
  "current_stage": 2,
  "available_tools": [
    { "id": "photo_review", "name": "AI Photo Review", "description": "Analyse job photos for compliance" },
    { "id": "property_passport", "name": "Property Passport", "description": "Full property compliance history" }
  ],
  "locked_tools": [
    { "id": "client_portal", "name": "Client Portal", "description": "...", "unlock_hint": "Complete 20 jobs to unlock" }
  ]
}
```

---

## Referral System

### POST /referral/generate
Generate a unique referral code for a user.

**Auth:** None

**Request:**
```json
{ "userId": "uuid" }
```

**Response:**
```json
{
  "referral_code": "SMITH123",
  "referral_link": "https://app.elemetric.app/signup?ref=SMITH123",
  "user_id": "uuid"
}
```

---

### POST /referral/track
Record a new referral when someone signs up with a code.

**Auth:** None

**Request:**
```json
{
  "referralCode": "SMITH123",
  "referredUserId": "uuid"
}
```

**Response:**
```json
{ "tracked": true, "referrer_id": "uuid" }
```

---

### POST /referral/verify
Check if a referral code is valid before displaying the signup discount.

**Auth:** None

**Request:**
```json
{ "referralCode": "SMITH123" }
```

**Response:**
```json
{
  "valid": true,
  "referrer_name": "John",
  "message": "Valid referral code from John."
}
```

---

### POST /referral/complete
Mark a referral as completed (called automatically on second billing cycle via Stripe webhook).

**Auth:** None

**Request:**
```json
{
  "referrerId": "uuid",
  "referredId": "uuid",
  "commissionAud": 10.00
}
```

**Response:**
```json
{ "completed": true, "commission_aud": 10.00 }
```

---

### GET /referral/stats
Get referral statistics for a user.

**Auth:** None

**Query params:**
- `userId` — string (required)

**Response:**
```json
{
  "user_id": "uuid",
  "total_referrals": 5,
  "completed_referrals": 3,
  "pending_referrals": 2,
  "total_commission_aud": 30.00,
  "referral_code": "SMITH123",
  "referral_link": "https://app.elemetric.app/signup?ref=SMITH123"
}
```

---

### GET /referral/leaderboard
Top referrers (anonymised).

**Auth:** None

**Response:**
```json
{
  "leaderboard": [
    { "rank": 1, "display_name": "Referrer #1", "completed_referrals": 12, "commission_aud": 120.00 }
  ],
  "generated_at": "2026-03-17T00:00:00.000Z"
}
```

---

## Timesheets

### POST /timesheet/clock-in
Clock in for a job shift.

**Auth:** None

**Request:**
```json
{
  "userId": "uuid",
  "employerId": "uuid",
  "jobId": "uuid",
  "location": "123 Smith St Richmond",
  "hourlyRate": 45.00,
  "notes": "Split system installation",
  "travel_allowance": 15.00,
  "tool_allowance": 5.00,
  "site_allowance": 0.00
}
```

**Response:**
```json
{
  "timesheet": {
    "id": "uuid",
    "user_id": "uuid",
    "clock_in": "2026-03-17T08:00:00.000Z",
    "status": "open"
  }
}
```

---

### POST /timesheet/clock-out
Clock out and calculate pay.

**Auth:** None

**Request:**
```json
{
  "userId": "uuid",
  "timesheetId": "uuid",
  "notes": "Job complete"
}
```

**Response:**
```json
{
  "timesheet": { "id": "uuid", "status": "closed", "total_hours": 9.5, "total_pay": 470.25 },
  "total_hours": 9.5,
  "total_pay": 470.25
}
```

---

### GET /timesheet/current
Get the currently open timesheet for a user.

**Auth:** None

**Query params:**
- `userId` — string (required)

**Response:**
```json
{
  "clocked_in": true,
  "timesheet": { "id": "uuid", "clock_in": "...", "status": "open" },
  "elapsed_hours": 3.5
}
```

---

### GET /timesheet/history
Get timesheet history for a user.

**Auth:** None

**Query params:**
- `userId` — string (required)
- `limit` — integer (optional, default 20)

**Response:**
```json
{
  "timesheets": [
    { "id": "uuid", "clock_in": "...", "clock_out": "...", "total_hours": 8, "total_pay": 360.00 }
  ]
}
```

---

### GET /timesheet/summary
Weekly earnings summary.

**Auth:** None

**Query params:**
- `userId` — string (required)
- `weekStartDate` — string (optional, e.g. `2026-03-16`)

**Response:**
```json
{
  "user_id": "uuid",
  "week_starting": "2026-03-16",
  "total_hours": 40.5,
  "total_pay": 1890.00,
  "shifts": 5
}
```

---

### POST /timesheet/payslip
Generate a full weekly payslip with overtime, penalty rates, and allowances.

**Auth:** None

**Request:**
```json
{
  "userId": "uuid",
  "weekStartDate": "2026-03-16",
  "allowances": {
    "travel": 15.00,
    "tools": 5.00,
    "site": 0.00
  }
}
```

**Response:**
```json
{
  "user_id": "uuid",
  "week_starting": "2026-03-16",
  "days_worked": 5,
  "total_hours": 42.0,
  "ordinary_hours": 38.0,
  "overtime_hours": 4.0,
  "weekly_ot_bonus_aud": 90.00,
  "total_allowances_aud": 100.00,
  "gross_pay_aud": 1710.00,
  "total_payable_aud": 1900.00,
  "daily_breakdown": [
    { "date": "2026-03-16", "hours": 8.5, "gross": 382.50, "is_public_holiday": false, "rate_multiplier": 1 }
  ],
  "generated_at": "2026-03-17T00:00:00.000Z"
}
```

**Notes:**
- Overtime triggers at 8 hours/day (1.5x) and 38 hours/week
- Saturday: 1.5x rate multiplier
- Sunday: 2.0x rate multiplier
- Victorian public holidays: 2.5x rate multiplier
- Allowances (travel, tools, site) added on top of pay

---

## Quotes

### POST /quote/create
Create a new job quote.

**Auth:** API key required

**Request:**
```json
{
  "userId": "uuid",
  "customerId": "uuid",
  "jobType": "plumbing",
  "description": "Hot water system replacement",
  "lineItems": [
    { "description": "Labour", "qty": 4, "unit_price": 120.00 },
    { "description": "HWS unit", "qty": 1, "unit_price": 850.00 }
  ]
}
```

**Response:**
```json
{
  "quote": {
    "id": "uuid",
    "status": "draft",
    "subtotal_aud": 1330.00,
    "gst_aud": 133.00,
    "total_aud": 1463.00
  }
}
```

---

### GET /quote/list
List quotes for a user.

**Auth:** API key required

**Query params:**
- `userId` — string (required)
- `status` — string (optional: `draft`, `sent`, `accepted`, `converted`)

---

### PUT /quote/accept
Accept a quote and create a linked job.

**Auth:** API key required

**Request:**
```json
{
  "quoteId": "uuid",
  "userId": "uuid"
}
```

**Response:**
```json
{
  "quote": { "id": "uuid", "status": "accepted" },
  "job": { "id": "uuid", "status": "scheduled" },
  "next_step": "Job scheduled — mark complete when done to convert to invoice."
}
```

---

### POST /quote/convert-to-invoice
Convert an accepted quote to a draft invoice, copying all line items.

**Auth:** API key required

**Request:**
```json
{
  "quoteId": "uuid",
  "userId": "uuid",
  "dueDate": "2026-04-01",
  "notes": "Payment terms: 14 days"
}
```

**Response:**
```json
{
  "quote_id": "uuid",
  "invoice": {
    "id": "uuid",
    "status": "draft",
    "due_date": "2026-04-01",
    "total_aud": 1463.00
  },
  "workflow": "quote → accepted → job → invoice"
}
```

---

## Analytics

### POST /analytics/aggregate
Pre-compute and cache employer analytics (84-day window). Returns instantly from cache after first call.

**Auth:** API key required

**Request:**
```json
{
  "employerId": "uuid",
  "forceRefresh": false
}
```

**Response:**
```json
{
  "employer_id": "uuid",
  "period_days": 84,
  "total_jobs": 247,
  "jobs_by_trade_type": { "plumbing": 120, "hvac": 80, "electrical": 47 },
  "avg_confidence_by_trade_type": { "plumbing": 84, "hvac": 79, "electrical": 88 },
  "most_common_missing_items": [
    { "item": "compliance plate", "count": 34 },
    { "item": "pressure test record", "count": 28 }
  ],
  "weekly_job_counts": [
    { "week": "2026-01-05", "count": 22 }
  ],
  "computed_at": "2026-03-17T00:00:00.000Z",
  "from_cache": false
}
```

**Notes:**
- Cache TTL: 1 hour. Pass `forceRefresh: true` to bypass.
- Background hourly refresh clears all cached entries.

---

## Client Portal

### POST /client/verify
Send a 6-digit verification code to a property owner's email.

**Auth:** None

**Rate limit:** 3 attempts per IP+email per hour

**Request:**
```json
{
  "email": "owner@example.com",
  "address": "123 Smith St Richmond VIC 3121"
}
```

**Response:**
```json
{ "sent": true, "message": "Code sent to owner@example.com" }
```

---

### POST /client/access
Exchange a verification code for a session token.

**Auth:** None

**Request:**
```json
{
  "email": "owner@example.com",
  "address": "123 Smith St Richmond VIC 3121",
  "code": "847261"
}
```

**Response:**
```json
{
  "session_token": "hexstring",
  "expires_in": 3600
}
```

---

### GET /client/reports
Get compliance reports for a property (requires session token).

**Auth:** `x-client-token` header

**Query params:**
- `address` — string (must match session address)

**Response:**
```json
{
  "address": "123 Smith St Richmond VIC 3121",
  "reports": [
    {
      "id": "uuid",
      "job_type": "plumbing",
      "overall_confidence": 87,
      "created_at": "2026-03-15",
      "certificate_id": "uuid"
    }
  ]
}
```

---

## Subcontractors

### POST /subcontractor/add
Add a subcontractor to an employer's team.

**Auth:** API key required

**Request:**
```json
{
  "employerId": "uuid",
  "fullName": "Jane Smith",
  "email": "jane@example.com",
  "licenceNumber": "VBA12345",
  "licenceExpiry": "2027-06-30",
  "insuranceExpiry": "2027-01-01",
  "tradeTypes": ["plumbing", "gas"]
}
```

---

### GET /subcontractor/compliance-summary
Get compliance summary for all active subcontractors under an employer.

**Auth:** API key required

**Query params:**
- `employerId` — string (required)

**Response:**
```json
{
  "employer_id": "uuid",
  "subcontractors": [
    {
      "id": "uuid",
      "name": "Jane Smith",
      "email": "jane@example.com",
      "licence_status": "valid",
      "insurance_status": "expiring_soon",
      "elemetric_jobs": 23,
      "average_compliance_score": 85,
      "trade_types": ["plumbing"]
    }
  ],
  "total": 1
}
```

---

### POST /subcontractor/request-report
Request a compliance report from a subcontractor via email.

**Auth:** API key required

**Request:**
```json
{
  "subcontractorId": "uuid",
  "employerId": "uuid",
  "jobDescription": "Bathroom renovation — HWS replacement",
  "jobAddress": "45 Jones Rd Collingwood",
  "dueDate": "2026-03-25"
}
```

**Response:**
```json
{
  "requested": true,
  "subcontractor": "Jane Smith",
  "email_sent": true
}
```

---

## Property Passport

### POST /property-passport
Get the full compliance history for a property address.

**Auth:** API key required

**Request:**
```json
{
  "address": "123 Smith St Richmond VIC 3121",
  "userId": "uuid"
}
```

**Response:**
```json
{
  "address": "123 Smith St Richmond VIC 3121",
  "compliance_grade": "B",
  "trade_history": ["hvac", "plumbing"],
  "total_jobs": 4,
  "avg_compliance_score": 81,
  "jobs": [...],
  "generated_at": "2026-03-17T00:00:00.000Z"
}
```

---

### POST /property-passport/claim
Claim a property to receive email notifications when new reports are added.

**Auth:** None

**Request:**
```json
{
  "address": "123 Smith St Richmond VIC 3121",
  "ownerEmail": "owner@example.com",
  "ownerName": "John Smith"
}
```

**Response:**
```json
{
  "claimed": true,
  "address": "123 Smith St Richmond VIC 3121",
  "notification_email": "owner@example.com"
}
```

---

## Notifications

### GET /notifications/failed
List all unresolved failed email notifications.

**Auth:** API key required

**Response:**
```json
{
  "failed": [
    {
      "id": "uuid",
      "type": "email",
      "recipient": "user@example.com",
      "subject": "Your compliance report",
      "error": "Connection timeout",
      "attempts": 3,
      "last_attempt": "2026-03-17T00:00:00.000Z",
      "resolved": false
    }
  ],
  "total": 1
}
```

---

### POST /notifications/retry
Manually retry a failed notification.

**Auth:** API key required

**Request:**
```json
{ "notificationId": "uuid" }
```

**Response:**
```json
{ "retried": true, "sent": true }
```

---

## Performance

### GET /performance
Returns average and max response times per endpoint, sorted slowest first.

**Auth:** API key required

**Response:**
```json
{
  "total_requests_logged": 500,
  "slow_threshold_ms": 2000,
  "endpoints": [
    {
      "endpoint": "POST /review",
      "calls": 120,
      "avg_ms": 3200,
      "max_ms": 8500,
      "errors": 2,
      "is_slow": true
    }
  ],
  "generated_at": "2026-03-17T00:00:00.000Z"
}
```

---

## Health & Status

### GET /health
Basic health check.

**Auth:** None

**Response:**
```json
{ "status": "ok", "timestamp": "2026-03-17T00:00:00.000Z" }
```

---

### GET /status
Extended status with usage stats.

**Auth:** None

**Response:**
```json
{
  "status": "ok",
  "uptime": 86400,
  "requests_served": 50000,
  "emails_sent": 1200,
  "cache_size": 234,
  "pending_analyses": 3
}
```

---

## Jobs

### POST /job/schedule
Schedule a job with date, time, and assignment.

**Auth:** API key required

**Request:**
```json
{
  "userId": "uuid",
  "jobId": "uuid",
  "scheduledDate": "2026-03-20",
  "scheduledTime": "09:00",
  "notes": "Call before arrival",
  "assignedTo": "uuid"
}
```

---

### GET /job/calendar
Get scheduled jobs in calendar format.

**Auth:** API key required

**Query params:**
- `userId` — string
- `startDate` — string (YYYY-MM-DD)
- `endDate` — string (YYYY-MM-DD)

---

## Benchmarking

### GET /benchmarking
Compare user's compliance scores against anonymised industry peers.

**Auth:** API key required

**Query params:**
- `userId` — string (required)
- `jobType` — string (optional)

**Response:**
```json
{
  "user_avg_score": 84,
  "industry_avg_score": 79,
  "percentile": 68,
  "job_type": "plumbing",
  "sample_size": 450
}
```

---

## Error Responses

All endpoints return errors in this format:

```json
{ "error": "Human-readable error message." }
```

Common status codes:
- `400` — Missing or invalid parameters
- `401` — Missing or invalid authentication
- `403` — Forbidden (wrong user or insufficient permissions)
- `404` — Resource not found
- `429` — Rate limit exceeded
- `500` — Server error
- `503` — External service (Supabase, OpenAI) not configured

---

## Rate Limits

| Endpoint group         | Limit                         |
|------------------------|-------------------------------|
| Global                 | 100 requests / 15 min per IP  |
| `/review`              | 20 requests / 15 min per IP   |
| `/stamp-photo`         | 30 requests / 15 min per IP   |
| `/client/verify`       | 3 requests / 1 hour per IP+email |
| AI endpoints           | Per-user daily limits apply   |

Daily per-user limits:
- Free: 50 analyses/day
- Individual: 200 analyses/day
- Employer: Unlimited

---

## SQL Migrations

The following Supabase migrations are included in `supabase/migrations/`:

| File | Description |
|------|-------------|
| `referrals.sql` | Referral tracking table |
| `subcontractors.sql` | Subcontractor profiles |
| `timesheets.sql` | Timesheet clock-in/out records |
| `training.sql` | Training mode sessions |
| `user_stages.sql` | Progressive disclosure stage tracking |
| `client_portal_audit.sql` | Audit log for client portal access |
| `regulatory_notifications.sql` | Tracks which users have been notified of regulatory updates |
| `failed_notifications.sql` | Failed email retry queue |
