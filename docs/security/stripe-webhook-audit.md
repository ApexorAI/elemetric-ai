# Stripe Webhook Security Audit
**Date:** Sunday 22 March 2026
**Auditor:** Claude Sonnet 4.6 (automated)

---

## Webhook Endpoint

- **Route:** `POST /webhook`
- **Authentication:** Stripe signature verification (not the global API key — exempt from `x-elemetric-key` check)
- **Body parsing:** `express.raw({ type: "application/json" })` — raw buffer preserved for HMAC verification. Registered **before** `express.json()` middleware to ensure the raw body is not consumed first.
- **Implementation:** `index.js:810–935`

---

## Signature Verification

### Implementation
```javascript
event = stripe.webhooks.constructEvent(req.body, sig, secret);
```
- Uses Stripe's official `constructEvent()` which verifies the HMAC-SHA256 signature using `STRIPE_WEBHOOK_SECRET`
- If signature is missing or invalid: returns `400` with `"Webhook Error: <message>"`
- The webhook secret is loaded from `process.env.STRIPE_WEBHOOK_SECRET` — never hardcoded
- If `STRIPE_WEBHOOK_SECRET` is not configured: returns `200` (to avoid failing Stripe) and logs a warning

### Test Scenario: Invalid Signature
Sending a POST to `/webhook` with a fabricated `stripe-signature` header causes `constructEvent()` to throw. The server returns:
```
HTTP 400: "Webhook Error: No signatures found matching the expected signature for payload."
```

---

## Idempotency

### Implementation
- `processedWebhookEvents` Map stores `eventId → processedAt timestamp`
- TTL: 24 hours (cleaned hourly)
- On duplicate event: returns `200 OK` immediately without re-processing
- Implementation: `index.js:767–774, 838–842`

### Events Processed
| Stripe Event | Action |
|-------------|--------|
| `customer.subscription.created` | Update `profiles` row with new role and subscription status |
| `customer.subscription.updated` | Update `profiles` row; handle referral completion on second payment |
| `customer.subscription.deleted` | Downgrade user to `free` role |
| `payment_intent.payment_failed` | Send payment failure email via Resend |
| `invoice.payment_succeeded` | Send payment confirmation email |

---

## Async Processing

- Stripe requires a `200` response within 30 seconds or it retries the event
- For events that may take longer (referral lookups, email sends): `res.sendStatus(200)` is returned immediately and processing continues asynchronously via a detached Promise
- Implementation: `index.js:846`

---

## Logging

Every webhook event is logged with:
- `event.type` — the Stripe event type
- `event.id` — the Stripe event ID
- Whether the event was a duplicate (and skipped)
- Outcome of the database update

Example log line:
```
Webhook: received event type=customer.subscription.created id=evt_1ABC123
Webhook: Updated user → role=pro status=active
```

---

## Email Address Masking

When logging customer emails in webhook context, the code masks the middle characters:
```javascript
email.replace(/(?<=.{2}).(?=.*@)/g, "*")
// "jo***@example.com" — prevents PII in Railway logs
```

---

## Webhook Secret Configuration

| Environment | Secret Source |
|-------------|--------------|
| Production (Railway) | `STRIPE_WEBHOOK_SECRET` env var |
| Local development | `.env` file (not committed) |

The startup env check warns if `STRIPE_WEBHOOK_SECRET` is not set. No secret is ever logged.

---

## Vulnerability Assessment

| Risk | Mitigation |
|------|-----------|
| Forged webhook events | Stripe HMAC-SHA256 signature verification |
| Replay attacks | 24-hour idempotency store |
| Stripe timeout (30s) | Immediate `200` response, async processing |
| Secret exposure in logs | Never logged — presence only checked |
| Duplicate subscription updates | Supabase `upsert` with `onConflict: "user_id"` is idempotent |

**Result: No vulnerabilities found.**
