# Security Logging and Monitoring Audit
**Date:** Sunday 22 March 2026
**Auditor:** Claude Sonnet 4.6 (automated)

---

## Security Event Log

### Implementation
- **Location:** `index.js:352–372` — `securityLog(severity, event, ip, userId, details)` function
- **Storage:** In-memory circular buffer, max 1,000 entries (oldest evicted first)
- **Severity levels:** `INFO`, `WARN`, `CRITICAL`
- **Fields logged per event:** `ts` (ISO timestamp), `severity`, `event` (type), `ip`, `userId`, `details` (object)
- **PII policy:** Never logs actual API keys, tokens, passwords, or user credentials

### Events Logged

| Event | Severity | Trigger |
|-------|----------|---------|
| `review_rejected_missing_type` | INFO | POST /review with no job type |
| `review_rejected_invalid_type` | INFO | POST /review with invalid type |
| `review_injection_attempt` | WARN | Injection pattern in type/suburb/subtype |
| `review_injection_in_label` | WARN | Injection pattern in image label |
| `review_invalid_base64` | WARN | Non-base64 characters in image data |
| `auth_failure_invalid_key` | WARN | Wrong or missing x-elemetric-key |
| `auth_request_from_blocked_ip` | WARN | Request from auth-blocked IP |
| `request_from_blocked_ip` | WARN | Request from failure-rate-blocked IP |
| `rate_limit_hit` | WARN | HTTP 429 returned to any client |
| `request_timeout` | WARN | Request exceeded timeout threshold |
| `ip_blocked_high_failure_rate` | WARN | IP exceeded 100 failures/minute |
| `ip_blocked_auth_brute_force` | CRITICAL | IP exceeded 10 auth failures |
| `chat_injection_attempt` | WARN | Injection pattern in chat message |
| `ai_daily_cost_threshold_exceeded` | CRITICAL | Daily AI spend exceeds $50 USD |
| `unhandled_route_error` | WARN | Uncaught error in route handler |
| `uncaught_exception` | CRITICAL | Node.js uncaughtException event |
| `unhandled_rejection` | CRITICAL | Node.js unhandledRejection event |

---

## Brute Force and Anomaly Detection

### IP Failure Rate Blocking
- **Threshold:** 100 failed requests in 1 minute
- **Block duration:** 10 minutes
- **Implementation:** `ipFailureTracker` Map, `trackIpFailure()`, `isIpBlocked()` — `index.js:378–404`

### Auth Brute Force Blocking
- **Threshold:** 10 failed authentication attempts from same IP
- **Block duration:** 1 hour
- **Implementation:** `AUTH_FAIL_TRACKER` Map, `trackAuthFailure()`, `isAuthBlocked()` — `index.js:406–421`
- **Alert:** CRITICAL security event logged immediately when block is triggered

### Automatic Cleanup
- Both trackers cleaned hourly to prevent unbounded memory growth — `index.js:424–432`

---

## GET /security-log Endpoint

- **Route:** `GET /security-log`
- **Authentication:** Protected by global `x-elemetric-key` middleware — admin access only
- **Returns:** Last 100 events (newest first), current blocked IPs, today's AI cost totals
- **Implementation:** `index.js:113028–113051`

### Sample Response Structure
```json
{
  "total": 47,
  "shown": 47,
  "events": [
    { "ts": "2026-03-22T10:15:00Z", "severity": "WARN", "event": "auth_failure_invalid_key", "ip": "1.2.3.4", "userId": null, "details": { "path": "/review", "keyPresent": false } }
  ],
  "ai_cost_today": {
    "date": "2026-03-22",
    "openai_usd": "0.0240",
    "anthropic_usd": "0.0060",
    "total_usd": "0.0300",
    "alert_threshold_usd": 50,
    "alerted": false
  },
  "blocked_ips": {
    "failure_blocked": [],
    "auth_blocked": []
  }
}
```

---

## Logging Safety

### What IS Logged
- IP addresses (anonymised pattern: only full IP, no partial logging)
- Request paths and HTTP methods
- Error types (not error messages, which may contain schema info)
- User IDs (UUID format, no PII)
- Aggregate counts and timestamps

### What is NEVER Logged
- API keys or tokens (actual values)
- User email addresses or names
- Request body content
- Database query text
- Stack traces in API responses
- Image data or base64 content

---

## Alerting

### CRITICAL Alert Threshold
- More than 10 auth failures from same IP in 5 minutes triggers:
  1. `CRITICAL` severity security log entry
  2. Console error output to Railway logs
  3. IP blocked for 1 hour

### AI Cost Alert
- Daily OpenAI + Anthropic spend ≥ $50 USD triggers:
  1. `CRITICAL` security log entry
  2. Console error to Railway logs

---

## Recommendations

1. Post-launch: integrate security log with an external SIEM (e.g., Datadog, Papertrail)
2. Set up Railway log alerts for `[SECURITY:CRITICAL]` prefix
3. Consider persisting security events to a Supabase `security_events` table for long-term retention beyond the 1,000 in-memory limit
4. Add automated email alert to admin when `CRITICAL` events occur
