# Deployment guide

## Runtime and configuration

Use a supported Node.js LTS release, MySQL 8+, and a process manager or managed application runtime. Install dependencies from the lockfile with `npm ci`.

Configure these settings in the deployment platform's secret store or in a `.env` file in the project root (copy `.env.example`). Real environment variables override `.env`. Never commit `.env`.

| Variable | Required | Notes |
|---|---|---|
| `PORT` | No | HTTP listener port; defaults to `3000` |
| `DB_HOST` | Yes | Inventory MySQL host |
| `DB_PORT` | No | Defaults to `3306` |
| `DB_NAME` | Yes | Dedicated Inventory database |
| `DB_USER` | Yes | Least-privilege application account |
| `DB_PASSWORD` | Yes | Never commit or log this value |
| `SESSION_SECRET` | Yes in production | Long, random secret; production startup fails if absent |
| `TRUST_PROXY` | Behind a reverse proxy | Set to `1` when Nginx or a load balancer terminates HTTPS, so secure cookies and per-visitor rate limits work. Leave unset on localhost |
| `HR_API_URL` | For HR sync | e.g. `http://localhost:3001` |
| `HR_API_TOKEN` | For HR sync | Inventory's API key issued by HR |
| `INVENTORY_DEPARTMENT_CODE` | For HR sync and ESS sign-in | HR `department_code` of the Inventory department |
| `JVZPAY_API_URL` | For ESS sign-in | e.g. `http://localhost:3002` |
| `JVZPAY_API_TOKEN` | For ESS sign-in | Token created for Inventory by the Accounting team |
| `ESS_LOGIN_MODE` | No | `local` (default, today's passwords) or `live` (ESS passwords through JVzPay) |
| `EMERGENCY_ADMIN_EMAIL` | No | The one local manager allowed to use a local password in `live` mode. Default: the oldest local (non-HR) manager |
| `ESS_ALLOWED_STATUSES` | No | JVzPay `employment_status` values allowed to sign in. Default `Active,On Leave` |
| `POSITION_ROLE_MAP` | No | Ordered `text=role` rules; a rule matches when its text appears in the HR title. Default `Inventory Manager=manager,Inventory Supervisor=supervisor,Inventory Staff=staff`; unmatched titles become `staff` |

Integration tokens are not settings: they live (hashed) in the `IntegrationTokens` table. Create one per caller with `npm run token -- create crm "CRM production"` and `npm run token -- create accounting "JVzPay production"`, copy the printed token once, and give it privately to that system's developers. `npm run token -- list` shows prefixes and last use; `npm run token -- revoke <id>` disables a token immediately. `INVENTORY_INTEGRATION_TOKEN` is no longer read; the server logs a warning if it is still set.
| `HR_SYNC_INTERVAL_MS` | No | Default `300000` (5 minutes) |
| `EXTERNAL_REQUEST_TIMEOUT_MS` | No | Timeout for HR/JVzPay calls. Default `8000` |
| `DB_LOGGING` | No | Set `true` only for short-lived diagnostics |

Do not expose MySQL to the public internet. Terminate TLS at a trusted reverse proxy/load balancer and forward only to the application. Configure secure cookies and HTTPS in production; the application sets session cookies as secure when `NODE_ENV=production`.

## Database setup and upgrades

1. Provision a dedicated database and least-privilege MySQL user.
2. Take and verify a restorable backup before deploying schema changes.
3. Configure the environment variables above.
4. Run `npm run migrate` in an interactive deployment/setup terminal. Confirm database creation only when the database account is permitted to create it.
5. Start with `npm start`; startup authenticates to MySQL, synchronizes Sequelize models, and applies compatibility/index helpers.
6. Create the CRM and Accounting tokens (see above). Verify the app can sign in, that the integration API returns `401` without a token, and `403` when the CRM token calls `/accounting/outbox` (and the other way round).

The current project uses Sequelize `sync()` plus idempotent migration helpers, not a versioned migration ledger. The compatibility helper converts legacy `admin` accounts and roles to `manager` and adds the supervisor role. Review schema diffs and test upgrades against a restored database copy before production rollout; do not run the interactive database-creation step with broad production privileges.

## Employee accounts (HR sync and ESS sign-in)

1. Before switching on HR sync, make sure the first local manager exists (`/register`). That account becomes the emergency admin.
2. Set the HR settings. The sync runs at startup, then every 5 minutes; managers can also click **Sync now** on **User management**. Employees of `INVENTORY_DEPARTMENT_CODE` get a deactivated account with no local password. Roles follow `POSITION_ROLE_MAP` unless a manager overrides them on the user's edit page.
3. Existing local accounts whose email matches an HR employee are linked to that employee (never the emergency admin).
4. Resigned, Terminated or Rejected employees, employees moved to another department, and employees missing from HR are deactivated at the next sync, and their sessions are deleted.
5. Set the JVzPay settings, test one employee sign-in, then set `ESS_LOGIN_MODE=live`. From then on employees sign in with their onboarding email and ESS password, and the first success activates the account. Only the emergency admin keeps a local password. All other local passwords stop working.
6. If JVzPay cannot be reached, employees see "ESS is unavailable, try again later"; the emergency admin can still sign in.

Every sign-in attempt is written to `LoginAttempts` (email, IP, mode, outcome, reason; never the password). Five failures for one email, or twenty from one IP, within 15 minutes block further attempts until the window passes.

The schema change for this feature is in `docs/sql/2026-11-16-hr-sync-ess-login.sql`. Review it and take a backup before the first start.

## Operations

- Run `npm test` in CI before deployment. To include the database-backed tests, set `TEST_DB_NAME` to a throwaway database whose name ends in `_test` (it is dropped and recreated).
- Watch the server log for `HR sync` warnings (conflicts such as duplicate emails) and review `LoginAttempts` for repeated `rate_limited` or `ess_unavailable` outcomes.
- Monitor application error logs and MySQL availability; redact authorization headers, passwords, and session data.
- Configure automated encrypted MySQL backups and periodically test point-in-time restore procedures. The application does not implement its own backup scheduler.
- Monitor pending `IntegrationOutbox` events. Consumers must retry and acknowledge only after their own durable processing succeeds.
- Rotate an integration token by creating a new one for that system, handing it over, then revoking the old one; no restart is needed.
- Use a reverse proxy request-size/rate limit for integration endpoints and restrict callers to trusted CRM/Accounting networks where possible.

## Known integration boundary

The CRM event and product API, the durable Accounting outbox, HR employee sync, and ESS sign-in through JVzPay are implemented and covered by database-backed tests run against stubbed HR and JVzPay responses. They still need an end-to-end check against the real HR (port 3001) and JVzPay (port 3002) services before a production readiness claim.
