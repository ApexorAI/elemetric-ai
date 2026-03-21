# OpenAI and Anthropic API Security Audit
**Date:** Sunday 22 March 2026
**Task:** 10 of 15

## Token Limits (All AI Calls)

All OpenAI and Anthropic API calls have explicit `max_tokens` limits:

| Endpoint / Use Case | Model | max_tokens |
|--------------------|-------|-----------|
| POST /review (compliance analysis) | gpt-4.1-mini | 1200 |
| POST /review (quality prescreen) | gpt-4.1-mini | 800 |
| POST /chat | claude-haiku-4-5-20251001 | 800 |
| POST /generate-description | gpt-4.1-mini | 400 |
| POST /summarise-report | gpt-4.1-mini | 500 |
| POST /job-summary | gpt-4.1-mini | 600 |
| POST /benchmark | gpt-4.1-mini | 600 |
| POST /export-report | gpt-4.1-mini | 350 |
| POST /auto-classify | gpt-4.1-mini | 150 |
| All other AI endpoints | gpt-4.1-mini | 150–600 |

**Risk:** Without max_tokens, a malicious prompt with repetition patterns could trigger infinite generation and exhaust API budget.

## Content Filtering (Prompt Injection)

`detectInjection()` function checks user-supplied text before passing to AI:

Patterns detected:
- `ignore all previous instructions`
- `you are now a different AI`
- `forget everything`
- SQL injection (`SELECT FROM WHERE`, `DROP TABLE`, `UNION SELECT`, `OR 1=1`)
- Script injection (`<script>`, `javascript:`)
- System prompt extraction (`reveal your system prompt`, `what are your instructions`)
- Instruction override (`override your system`, `new instructions`)

Applied to:
- `/review`: `type`, `suburb`, `subtype`, all image `label` fields
- `/chat`: all user message content

## Cost Monitoring

### Daily Spend Tracking
`trackAiCost(provider, usd)` called on every AI API call:
- OpenAI calls: estimated $0.002 per call (gpt-4.1-mini vision)
- Anthropic calls: estimated $0.001 per call (claude-haiku)

### Alert Threshold: $50 USD/day
When total daily spend reaches $50:
1. `SECURITY_LOG` receives a `CRITICAL` event: `ai_daily_cost_threshold_exceeded`
2. Console error: `[AI-COST] ALERT: Daily AI spend $XX.XX USD exceeds $50 threshold!`
3. Alert visible at `GET /security-log`

### Spend Reset
`AI_COST_TRACKER` resets at midnight UTC. Cost tracking is in-memory — resets on server restart.

## AI Call Logging

Every AI call logs:
- Provider (openai / anthropic)
- Model name
- User ID (anonymised — present/absent flag for /review, actual for /chat billing)
- Token counts (input + output) for billing reconciliation
- Response time in milliseconds

## Retry Policy

`callOpenAIWithRetry()`:
- Retries once after 3 seconds on network/5xx errors
- Does NOT retry on 4xx errors (auth failures, bad requests)
- 25-second timeout via Promise.race before retry

## Recommendations

1. Integrate OpenAI usage billing alerts via their dashboard as a secondary control
2. Move cost tracking to Supabase for persistence across restarts
3. Consider adding rate limiting per userId on AI calls (separate from daily limits)
4. Add Anthropic billing alerts in Anthropic console
