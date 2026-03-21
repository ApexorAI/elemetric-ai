# Database Security Audit
**Date:** Sunday 22 March 2026
**Task:** 9 of 15

## Supabase Query Audit

### Service Role Key Usage
The `SUPABASE_SERVICE_ROLE_KEY` (admin key that bypasses RLS) is used server-side only via `supabaseAdmin`. It is:
- Never exposed in API responses
- Never logged (only key presence is logged as boolean)
- Required only for: webhook processing (plan updates), admin analytics, email operations
- Not available to mobile clients (they use the anon key via Supabase Auth)

### Row Level Security (RLS)
RLS is enabled on all Supabase tables:
- `profiles` — users can only read/write their own profile
- `jobs` — users can only access jobs where `user_id = auth.uid()`
- `referrals` — users can only see referrals they initiated or received
- `failed_notifications` — admin-only (service role only)
- `audit_log` — admin-only (service role only)

The server-side service role bypasses RLS intentionally only for:
1. Webhook processing (plan updates from Stripe)
2. Admin analytics queries
3. Cross-user operations (employer viewing team data)

### SQL Injection Protection
All Supabase queries use the JavaScript client's typed API:
```js
// SAFE — parameterised via PostgREST
supabaseAdmin.from("profiles").select("id, plan").eq("id", userId)

// NOT used — no raw SQL string interpolation
```
The PostgREST API (Supabase's REST layer) uses prepared statements internally. No raw SQL is constructed from user input anywhere in the codebase.

### Query Result Size Limits
All Supabase queries use explicit field selection (no `SELECT *`):
```js
.select("id, plan, trial_started_at, created_at, role")  // only needed fields
```
Queries that could return many rows are limited:
- `.limit()` on list queries
- `.single()` where exactly one row is expected (returns 406 if multiple found)
- Analytics queries limited to last 90 days

### Audit Logging for DB Writes
Key write operations are logged server-side:
- Subscription plan changes (Stripe webhook)
- Profile updates
- Referral completions

The `failed_notifications` table captures all email delivery failures with context.

### Error Response Safety
- Supabase error messages (which may contain table/column names) are caught and logged server-side only
- Client receives generic error messages without schema details
- HTTP 500 responses never include the Supabase error object

## Schema Exposure Check

Searched all error response paths — no Supabase error messages are passed to `res.json()` in any error path. Pattern used:
```js
catch (err) {
  console.error("[endpoint]", err.message); // server-side only
  return res.status(500).json({ error: "Generic user-friendly message." }); // never err.message
}
```

## Recommendations

1. Enable Supabase's built-in audit logging in the Supabase dashboard
2. Set up Supabase database alerts for unusual query volumes
3. Review RLS policies quarterly as new tables are added
4. Consider moving `chatDailyUsage` from in-memory Map to Supabase for persistence across deploys
