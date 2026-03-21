# Error Handling Security Audit
**Date:** Sunday 22 March 2026
**Auditor:** Claude Sonnet 4.6 (automated)

---

## Global Error Handlers

### Node.js Process-Level Handlers

#### uncaughtException
- **Implementation:** `index.js:6–14`
- **Behaviour:** Logs full error + stack to console (server-side only), calls `securityLog("CRITICAL", ...)`, then exits after 500ms to allow Railway to flush logs before restart
- **Client exposure:** None — process exits before responding to any request

#### unhandledRejection
- **Implementation:** `index.js:16–20`
- **Behaviour:** Logs the rejection reason (message only, not stack) to console and security log
- **Client exposure:** None

---

## Express Error Handler

### Implementation
`index.js:113062–113091` — four-argument Express error middleware registered after all routes and the 404 handler.

### What it catches
- CORS policy violations (`err.message.startsWith("CORS:")`)
- Body parser payload-too-large errors (`err.type === "entity.too.large"`)
- Any unhandled throw from within a route handler
- Errors from middleware (e.g., bad `Authorization` header format)

### Client Response Policy
| Error Type | HTTP Status | Response Body |
|------------|------------|---------------|
| CORS violation | 403 | `{ "error": "CORS policy violation.", "code": "ERR_CORS" }` |
| Payload too large | 413 | `{ "error": "Request payload too large.", "code": "ERR_PAYLOAD_SIZE" }` |
| Any other error | 500 (or err.status if 4xx/5xx) | `{ "error": "An unexpected error occurred. Please try again.", "code": "ERR_INTERNAL" }` |

### What is NEVER sent to clients
- Stack traces
- File system paths
- Database error messages or query text
- Internal function names
- Schema information

---

## Error Codes

Every error response includes a machine-readable `code` field:

| Code | Meaning |
|------|---------|
| `ERR_INVALID_INPUT` | Failed input validation (bad type, missing field, injection attempt) |
| `ERR_UNAUTH` | Missing or invalid API key |
| `ERR_AUTH_BLOCKED` | IP temporarily blocked after repeated auth failures |
| `ERR_IP_BLOCKED` | IP temporarily blocked after high failure rate |
| `ERR_TIMEOUT` | Request exceeded endpoint timeout |
| `ERR_CORS` | Request from disallowed origin |
| `ERR_PAYLOAD_SIZE` | Request body exceeds size limit |
| `ERR_NOT_FOUND` | 404 — endpoint does not exist |
| `ERR_INTERNAL` | Unexpected server error |
| `ERR_NO_PHOTOS` | No valid photos submitted to /review |
| `ERR_IMAGE_TOO_LARGE` | Individual image exceeds 2MB limit |

---

## Route-Level Error Handling

All major route handlers wrap logic in `try/catch` and return specific error codes. Example pattern:

```javascript
app.post("/review", reviewLimiter, async (req, res) => {
  try {
    // ... handler logic
  } catch (err) {
    console.error("[review] Unexpected error:", err.message);
    return res.status(500).json({ error: "Analysis failed. Please try again.", code: "ERR_INTERNAL" });
  }
});
```

This means route errors are caught before reaching the global handler, ensuring consistent responses.

---

## 404 Handler
- **Implementation:** `index.js:113054–113056`
- **Response:** `{ "error": "Not found.", "code": "ERR_NOT_FOUND" }`
- Never exposes which routes exist or internal routing structure

---

## Error Logging Safety

The global error handler logs:
```javascript
securityLog("WARN", "unhandled_route_error", ip, null, {
  path:   req.path,
  method: req.method,
  type:   err.constructor?.name || "Error",  // e.g. "TypeError", "SyntaxError"
  status: err.status || 500,
});
```

Note: `err.message` is intentionally NOT logged to the security event store because it may contain database schema, file paths, or query text. It is only logged to the Railway console (server-side), where it is not accessible to clients.

---

## Audit Result

| Check | Status |
|-------|--------|
| Global uncaughtException handler | PASS |
| Global unhandledRejection handler | PASS |
| Express 4-arg error middleware | PASS |
| Stack traces never sent to clients | PASS |
| File paths never sent to clients | PASS |
| DB error text never sent to clients | PASS |
| Error codes present on all errors | PASS |
| 404 handler does not expose routes | PASS |

**Result: All error paths tested. No sensitive information leaks identified.**
