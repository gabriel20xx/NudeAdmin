# NudeAdmin

Administrative dashboard for managing the NudeForge / NudeFlow platform and shared database.

## Runtime Guarantees (Recent Additions)
* Migrations-before-listen: The server now awaits database initialization and migrations completion before binding the HTTP port. First request is therefore guaranteed to see a fully migrated schema (no transient 500s due to missing tables).
* Structured Logging: All analytics/tag endpoints emit start/success (or error) domain logs (DOMAIN: ADMIN_MEDIA / ADMIN_STATS). Use these for lightweight ops tracing rather than ad-hoc console output.
* Dashboard Image Overlay: Leader tiles (most viewed/liked/saved/downloaded, fastest/slowest generation) are now clickable to open a full-size preview overlay (accessible, with Close button + backdrop click to dismiss). Tests assert presence of overlay DOM.
* Longest View Metric: `metrics.longestView` (media_key + duration_ms) returned in stats API when available.

## Goals
Provide privileged (admin-role) tooling to:
- Inspect and manage users (activation, roles, bans).
- Review and moderate generated media / queues.
- Adjust platform settings (limits, feature toggles) safely.
- Maintain an admin profile / credentials.

## Tech Stack
- Node.js + Express (lightweight server)
- EJS templates (server-rendered views)
- Shared design tokens + UI utilities from `NudeShared` (`/shared/client/theme.css`, scripts)

## Session Management (Shared Factory)
Sessions are now provisioned via the shared `createStandardSessionMiddleware` exported from `NudeShared/server/index.js` (see central Copilot instructions for deep details). This replaces any ad-hoc `express-session` setup.

Key behaviors:
- Automatically prefers a Postgres session store (via `connect-pg-simple`) when `DATABASE_URL` is set, else falls back to in‑memory (dev/test) with a one-time WARN.
- Standard cookie attributes: httpOnly, sameSite=lax, 7‑day maxAge. `secure` auto-upgrades on HTTPS unless overridden.
- Accepts options: `{ serviceName, secret, cookieName, domain, maxAgeMs, enablePgStore, secureOverride }` – typically only `serviceName` & `secret` are passed here.
- Must be mounted AFTER body parsers (JSON/urlencoded) but BEFORE auth routes. The app mounts auth manually after session creation to avoid body parsing order issues.

Minimal integration pattern (already applied in `src/app.js`):
```js
import { createStandardSessionMiddleware } from '../../NudeShared/server/index.js';
// ... inside bootstrap before auth router:
app.use(createStandardSessionMiddleware({ serviceName: 'NudeAdmin', secret: process.env.SESSION_SECRET }));
```

Do not reintroduce inline session configuration blocks; extend the factory if new cross‑service behavior is needed.

## Tabs
| Tab | Purpose |
|-----|---------|
| Users | User list, role changes, status (future: search, filters). |
| Media | Moderation queue & browsing of generated outputs. |
| Settings | Platform configuration (limits, toggles) – wired later to persistent store. |
| Profile | Admin’s own profile / password / 2FA (future). |

Stats API now also reports `metrics.longestView` (media_key + duration_ms) sourced from `media_view_sessions` recorded via NudeForge / NudeFlow view-session events.

## Caching & Introspection

NudeAdmin aligns with the platform caching strategy:

| Asset Type | Policy |
|------------|--------|
| `/shared/*.css` & `/shared/*.js` | `public, max-age=3600` |
| `/shared/*.(png|jpg|jpeg|gif|webp|svg)` | `public, max-age=86400, stale-while-revalidate=604800` |
| Thumbnail route `/thumbs/output/*` | `public, max-age=86400` |
| Theme CSS (`/assets/theme.css`) | `public, max-age=3600` |
| `/output/*` originals | (default express static headers – adjust if needed) |

Introspection endpoint (unauthenticated, for ops/debug):

```
GET /__cache-policy
```

Returns a JSON structure describing active policies and ETag mode (strong ETags enabled). Secure or disable if exposing publicly.
Optional hardening:
- Set `REQUIRE_CACHE_POLICY_AUTH=true` to hide the endpoint unless a session user is present (responds 404 otherwise).
- Automatic rate limit: 60 requests/minute/IP (HTTP 429 when exceeded).

### Shared Helpers Usage
This service uses shared HTTP helpers from `NudeShared`:

- `mountSharedStatic(app, { candidates })` – mounts `/shared` with tiered caching.
- `registerCachePolicyEndpoint(app, { service, getPolicies })` – standard `/__cache-policy` endpoint.

If you add new asset categories (e.g., fonts) update the policies in `app.js` and ensure `getPolicies()` reflects them.

## Layout & Styling
The app consumes the shared theme directly by mounting the `NudeShared` directory at `/shared`.

## Running Locally
```bash
npm install
npm start
```
Then visit: http://localhost:8090

Environment variables (optional):
```
PORT=8090
NUDESHARED_DIR=../NudeShared
```

## Roadmap (Next Steps)
- Hook user list to real DB (`NudeShared/server/db`).
- Implement media moderation list (pagination, filters, actions).
- Persist settings (store in DB or versioned config table) with audit logging.
- AuthN/AuthZ middleware (reuse `authRoutes` & session/JWT strategy).
- Global search bar (users, media).
- Activity / audit log view.

## Notes
Current implementation is scaffold-only (no privileged enforcement yet). Integrate authentication & role checks before deploying.

---
Maintained by: gabriel20xx