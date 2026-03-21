# Request Size and Payload Limits Audit
**Date:** Sunday 22 March 2026
**Task:** 8 of 15

## Per-Endpoint Size Limits

| Endpoint | Size Limit | Reason |
|---------|-----------|--------|
| `POST /review` | 20MB | 10 photos × 2MB each (compressed JPEG/HEIC) |
| `POST /bulk-review` | 20MB | Same as /review |
| `POST /visualise` | 10MB | High-res wall photo for AI inpainting |
| `POST /stamp-photo` | 5MB | Single photo for timestamp watermark |
| `POST /export-report` | 2MB | Report data only |
| `POST /chat` | 50KB | Text messages only — no images |
| All other endpoints | 100KB | Text/data payloads only |

**Implementation:** Per-endpoint `express.json({ limit })` middleware — route-aware before JSON parsing.

## Per-Image Size Limit (POST /review)

- Maximum **2MB per individual image** (verified in base64 decode check)
- Maximum **30 images per request** (30 × 2MB = 60MB theoretical max, but payload limited to 20MB)
- MIME types: `image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `image/heic`, `image/heif` only

## Request Timeouts

| Endpoint | Timeout | Reason |
|---------|---------|--------|
| `POST /review` | 35 seconds | AI call (25s) + quality prescreen + retry |
| `POST /bulk-review` | 35 seconds | Same as /review |
| `POST /visualise` | 35 seconds | Replicate inference can be slow |
| All other endpoints | 10 seconds | Should respond immediately |

**Implementation:** Custom timeout middleware that responds with `503 ERR_TIMEOUT` if handler hasn't finished within the limit.

**Note:** The internal OpenAI timeout in `/review` is 25 seconds (Promise.race). The 35-second endpoint timeout gives 10 seconds of headroom for preprocessing and response building.

## Unexpected Field Rejection

- Global `sanitiseValue()` strips control characters from all body fields
- Injection patterns in unexpected fields are caught by `detectInjection()` on key fields
- Supabase `.select()` calls explicitly name required fields — unrecognised fields are ignored by the ORM

## HTTP Parameter Pollution Protection

Express 5.x (current version) handles duplicate query parameters by taking the last value by default. No additional HPP middleware is required for the current endpoint design (all inputs are JSON body, not query strings, for POST endpoints).

## Changes Made
- Changed global `express.json({ limit: "10mb" })` to per-endpoint adaptive limit middleware
- Added 35-second timeout for AI endpoints, 10-second for all others
- Added 30-image array length limit on /review
- Added 2MB per-image size limit with base64 byte calculation
- Added 50-message history limit on /chat
