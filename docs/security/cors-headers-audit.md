# CORS and Security Headers Audit
**Date:** Sunday 22 March 2026
**Task:** 7 of 15

## CORS Configuration

### Allowed Origins
```
https://elemetric.com.au
https://www.elemetric.com.au
https://app.elemetric.com.au
https://elemetric-server-production.up.railway.app
```
Additional origins can be added via `ALLOWED_ORIGINS` environment variable (comma-separated).

### Mobile App Access
Requests with no `Origin` header (React Native mobile app, Expo, server-to-server) are **allowed without restriction** — CORS is a browser security policy and does not apply to mobile apps.

### CORS Blocking Test
Requests from unknown origins (e.g., `https://attacker.com`) in production (`NODE_ENV=production`) receive:
```
HTTP 500 — CORS: origin 'https://attacker.com' not permitted.
→ Handled by global error handler → returns: {"error":"CORS policy violation.","code":"ERR_CORS"}
```

### Allowed Methods
`GET, POST, PUT, PATCH, DELETE, OPTIONS`

### Allowed Headers
`Content-Type, x-elemetric-key, Authorization, x-api-key`

### Credentials
`credentials: true` — required for mobile auth token headers.

## Security Headers (Helmet — Maximum Configuration)

| Header | Value | Protection |
|--------|-------|-----------|
| `Content-Security-Policy` | Strict: self only, no eval, no inline scripts | XSS, code injection |
| `X-Frame-Options` | `DENY` | Clickjacking |
| `X-Content-Type-Options` | `nosniff` | MIME type sniffing |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | SSL stripping (2-year HSTS) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referrer leakage |
| `Cross-Origin-Opener-Policy` | `same-origin` | Cross-origin window access |
| `Permissions-Policy` | Disables camera, microphone, geolocation, payment, USB, accelerometer, gyroscope | Feature abuse |

## Permissions-Policy Header
Added manually (helmet does not cover this):
```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=()
```

## Changes Made
- Upgraded `helmet()` from default configuration to explicit maximum configuration
- Added `Permissions-Policy` header via custom middleware
- CORS error now returns `ERR_CORS` code with generic message (no internal detail)
- Verified mobile app (no Origin header) continues to work correctly
