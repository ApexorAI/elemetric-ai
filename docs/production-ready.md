# Elemetric Server — Production Readiness Report

**Generated:** 2026-03-17
**npm audit:** 0 vulnerabilities found

---

## Security

- API key authentication (`apiKeyAuth` middleware) on all privileged endpoints
- Input sanitisation via `sanitiseInput()` on all user-supplied strings
- Email validation via `isValidEmail()` before sending
- HTML escaping via `escHtml()` in all email templates
- Client portal uses short-lived in-memory session tokens (1 hour TTL) with automatic cleanup every 15 minutes
- Verification codes are single-use and expire in 10 minutes
- Supabase RLS enabled on all new tables (referrals, subcontractors, timesheets)

## New Endpoints (Tasks 1-9)

### Task 1 — Referral System
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/referral/generate` | POST | None | Generate unique referral code for a user |
| `/referral/track` | POST | None | Record a signup via referral link |
| `/referral/complete` | POST | None | Mark referral complete, send commission email |
| `/referral/stats` | GET | None | User referral stats and earnings |
| `/referral/leaderboard` | GET | None | Top 10 referrers (anonymised) |

### Task 2 — Client Portal
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/client/verify` | POST | None | Send 6-digit code to client email |
| `/client/access` | POST | None | Exchange code for session token |
| `/client/reports` | GET | Client token | All compliance reports for a property |
| `/client/certificate/:jobId` | GET | Client token | Full compliance certificate for a job |

### Task 3 — Subcontractor Management
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/subcontractor/add` | POST | API key | Add new subcontractor |
| `/subcontractor/list` | GET | API key | List subcontractors with expiry flags |
| `/subcontractor/update` | PUT | API key | Update subcontractor details |
| `/subcontractor/remove` | DELETE | API key | Soft-delete subcontractor |
| `/subcontractor/check-expiry` | POST | API key | Check and email expiring documents |

### Task 4 — Benchmark (updated)
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `GET /benchmark` | GET | None | Real Supabase aggregate benchmarking with percentiles, suburb context, improvement velocity |

### Task 5 — Training Mode
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/training` | POST | None | AI coaching feedback on a training photo (0-10 score, regulation reference) |

### Task 6 — Timesheets
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/timesheet/clock-in` | POST | None | Start a new timesheet session |
| `/timesheet/clock-out` | POST | None | Close a session, calculate hours/pay |
| `/timesheet/current` | GET | None | Check current open session |
| `/timesheet/history` | GET | None | Paginated history of closed sessions |
| `/timesheet/summary` | GET | None | Period summary with job breakdown and CSV export |

### Task 7 — Regulatory Updates (updated)
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `GET /regulatory-updates` | GET | None | 10 real AS/NZS updates 2020-2025 with user impact analysis |

### Task 8 — Employer Analytics
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/employer/analytics/overview` | GET | API key | Compliance overview for employer |
| `/employer/analytics/trends` | GET | API key | 12-week weekly compliance trends |
| `/employer/analytics/failures` | GET | API key | Top missed items across all jobs |
| `/employer/analytics/plumber/:id` | GET | API key | Deep-dive on individual plumber performance |
| `/employer/analytics/export` | GET | API key | Monthly CSV export for Excel |

### Task 9 — Tradify Feature Parity
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/quote/create` | POST | API key | Create quote with line items, GST calculation |
| `/quote/list` | GET | API key | List quotes with filters |
| `/quote/accept` | PUT | API key | Accept quote and create linked job |
| `/job/schedule` | POST | API key | Schedule a job with date/time |
| `/job/calendar` | GET | API key | Calendar view of scheduled jobs |
| `/customer/create` | POST | API key | Create customer record |
| `/customer/list` | GET | API key | List customers with job counts |
| `/job/cost` | POST | API key | Calculate job cost with overhead and margin |

## SQL Migrations

All migrations are in `supabase/migrations/`:
- `referrals.sql` — referrals table with RLS
- `subcontractors.sql` — subcontractors table with RLS
- `training.sql` — training_submissions table
- `timesheets.sql` — timesheets table with RLS

## Infrastructure

- Node.js Express server
- OpenAI GPT-4o-mini for AI analysis
- Supabase (PostgreSQL) for persistence
- Resend for transactional email
- In-memory caching with LRU-Cache
- Stripe for payments
