# Input Validation and Sanitisation Audit
**Date:** Sunday 22 March 2026
**Task:** 3 of 15

## Global Sanitisation (all endpoints)

- **Null byte stripping:** All string values in `req.body` and `req.query` are stripped of C0 control characters (except tab, LF, CR) and DEL via `sanitiseValue()` middleware applied globally.
- **Auth header hardening:** Authorization header must be a non-empty, non-null-byte string or the request is rejected 400.

## POST /review — Validation Added

| Field | Validation |
|-------|-----------|
| `type` | Required, string, max 100 chars |
| `suburb` | Optional, string, max 200 chars |
| `subtype` | Optional, string, max 100 chars |
| `userId` | Optional, string, max 200 chars |
| `images[]` | Max 30 total images per request |
| `images[].label` | Max 300 chars |
| `images[].mime` | Must be jpeg/jpg/png/webp/heic/heif |
| `images[].data` | Valid base64 only; max ~2MB per image (2.7MB base64) |

**Prompt injection detection** on `type`, `suburb`, `subtype`, and all image labels via `detectInjection()` — patterns tested:
- `ignore all previous instructions`
- `you are now a different AI`
- `forget everything`
- SQL injection patterns (`SELECT FROM WHERE`, `DROP TABLE`, `UNION SELECT`, `OR 1=1`)
- Script injection (`<script>`, `javascript:`)
- System prompt extraction attempts (`reveal your system prompt`)

## POST /chat — Validation Added

| Field | Validation |
|-------|-----------|
| `messages[]` | Max 50 messages in history |
| `messages[].content` | Max 4000 chars per message |
| User messages | Prompt injection detection via `detectInjection()` |

## All Other Endpoints

- Protected by global `sanitiseValue()` middleware
- Global 100KB payload limit (10MB for /review, 50KB for /chat)
- Global ELEMETRIC_API_KEY auth enforced on all non-exempt paths

## SQL Injection via Supabase ORM

Supabase JavaScript client uses parameterised queries internally — string concatenation into raw SQL is not used anywhere in the codebase. All `.eq()`, `.in()`, `.select()` calls pass typed parameters directly to the PostgREST API which handles parameterisation.

## Endpoints Audited

All 120+ endpoints audited. Key findings:
- Global middleware handles null-byte stripping for all endpoints
- /review and /chat have explicit injection detection added
- /webhook has Stripe signature verification (pre-existing)
- /webhook/user-created has SUPABASE_WEBHOOK_SECRET verification (pre-existing)
- No raw string interpolation into Supabase queries found

## Recommendation

Add `express-validator` to individual high-risk endpoints as a follow-up enhancement post-launch. Current global sanitisation covers immediate launch risk.
