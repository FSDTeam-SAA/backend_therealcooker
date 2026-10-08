# MoneyKee admin operations

## Implemented

- `/admin/dashboard/overview?days=7|30|90`: real user, account, security, learning and availability aggregates and daily trends. Dates use UTC.
- `/admin/alerts`: pagination, dates, type, severity, status, verdict and title search. PATCH requires a reason; resolutions retain explanation and reviewer. Resolving the review item does **not** clear an active SOS or unlock an account.
- `/admin/cases`: create and review cases, link alerts/users, assign active operators, add notes, record resolution method and first action time.
- `/admin/users/:id/overview`: demographics, active account count, recent alerts/cases and SOS clearance history. Account numbers, coordinates, OTPs and KYC raw responses are excluded.
- `/admin/accounts`, `/admin/events`, `/admin/audit`: paginated operational drill-down. Analyst event results exclude identities and entity IDs.
- `/admin/health`: sampled availability history. Optional `INTEGRATION_HEALTH_URLS` is a JSON object of operator-approved health URLs, for example `{"partner-sandbox":"https://partner.example/health"}`. No provider response content is stored. Checks run every minute with a five-second timeout.
- `/admin/me`, `/admin/staff`, `/admin/staff/:id/role`: current permissions and role management. Only superadmins may change another admin's role. Self-demotion is prevented.

## Role policy

Existing admins default to `superadmin` to preserve existing access. Review and assign least-privilege roles before operational rollout:

| Role | Access |
| --- | --- |
| superadmin | All existing management features, operational data, audit and staff roles |
| operations | Users and block/unblock, accounts, alerts/cases, events, learning/verification read, health |
| support | Users, alerts and learning read, cases read/write, health |
| analyst | Aggregate overview, redacted events, learning read, health |

Backend route permissions are checked against the current database role on every request. The UI refreshes permissions every 30 seconds. Learning results expose user identities only to roles with the separate `learning:results` permission.

## Data definitions and limits

- Registered users: currently retained `role=user` records; deleted users are not recoverable as an all-time signup total.
- Email verification and KYC completion are separate metrics.
- Active users: one daily UTC activity record per non-admin authenticated user making a successful API request. Weekly/monthly use 7/30 calendar days. Public browsing and anonymous verification lookup do not identify active users.
- Bank counts reflect active bank records, **not** confirmed live financial connections. Bank names currently use existing stored values.
- SOS and guardian attention alerts are the two implemented panic flows. The client's third panic needs a definition and mobile flow.
- Repeated limit-increase alerts come from the existing simulation; no real bank monitoring/freeze integration is claimed.
- Default severities: SOS critical, guardian attention/account locks high, suspicious simulated limits elevated. Operators can review/change them.
- False-positive rate divides false positives by reviewed alerts created in the selected period; unreviewed alerts are excluded.
- Operator response time starts at alert creation and ends at its first admin review/case action. Automated locks or user/guardian clearance do not count as MoneyKee operator response.
- Confirmed trend uses creation dates of alerts currently reviewed as confirmed.
- Learning start means fetching a quiz. Completion means its first successful full submission. Duration covers first open to first submit, not active screen time. Additional questions mean answers in repeat submissions. Lesson reading and a distinct optional-question flow still need mobile instrumentation.
- Availability is sampled in-process; a stopped process cannot record its own outage. Use an external monitor for complete uptime. Database outage samples may be lost while storage is unavailable.
- Telemetry is best effort and failures are logged without interrupting emergency safety flows. It is not a guaranteed/compliance-grade immutable audit store. Admin audits capture successful request method, route, target, actor, outcome and supplied reason; no credential-bearing request bodies are retained.
- No retrospective activity/lookup/duration records are fabricated. Choose retention periods with the product/data owner; automatic deletion is not enabled by default.

## Migration and rollout

Run from the backend directory against the **intended** database. Both scripts default to read-only counts:

```powershell
node scripts/remove-plaintext-passwords.js
node scripts/backfill-operations.js
```

After reviewing the counts and deployment target:

```powershell
node scripts/remove-plaintext-passwords.js --apply
node scripts/backfill-operations.js --apply
```

The first removes only the legacy `textPassword` field, preserving password hashes. Code no longer writes or exposes that field. User serialization also removes hashes, refresh tokens (except explicit authentication issuance), reset tokens and KYC raw data.

Backfill is idempotent and preserves existing admin reviews. It recovers SOS history, deduplicated guardian alerts and suspicious-limit records; it does not infer admin response times or invent case outcomes. Both scripts have been written but not run against a live database by this implementation.

Deploy backend and admin together. Existing mobile API response shapes are preserved; learning progress instrumentation is added to current quiz fetch/submission endpoints. Real external providers, third panic, dedicated optional questions and external uptime monitoring remain dependencies.

## Verification

```powershell
node --test --experimental-test-isolation=none test/*.test.js
```

The isolation flag avoids Windows sandbox child-process restrictions. Admin validation: `npm run lint`, `npm run test:auth`, `npm run build`.
