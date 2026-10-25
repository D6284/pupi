# Supabase PostgreSQL Migration

## Storage Model

The Express application now uses asynchronous PostgreSQL storage when deployed to Vercel or when `DATABASE_URL` is configured. Local development without that variable keeps the JSON adapter. JSON writes are disabled whenever `NODE_ENV=production` or `VERCEL` is set. The PostgreSQL schema is in `config/schema.sql`; JSON payloads retain existing fields and IDs, with separate tables for settings, puppies, customers, conversations, messages, orders, and payments. Foreign keys preserve conversation/message, puppy/order, and order/payment relationships. Browser roles have no direct table access; server access uses the private database connection. Vercel rate limits use shared PostgreSQL counters keyed by a hash of the route and client IP.

Vercel functions do not run a persistent Socket.IO server. Local deployments retain Socket.IO; Vercel clients refresh chat data through the authenticated APIs every five seconds.

## Configuration

1. Create a Supabase project for development first. Use its PostgreSQL connection pooler for Vercel serverless requests; keep the database connection string server-side.
2. Copy `.env.example` to `.env` for local work. Configure `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD_HASH`, and optionally `GEMINI_API_KEY`. Never commit `.env` or send these values to the browser.
3. Generate a stable JWT secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Generate the initial administrator bcrypt hash locally; use a strong passcode of at least 12 characters. The application will not use the JSON file's legacy JWT secret or password on Vercel.
4. Configure the same variables in Vercel Project Settings for Preview and Production, using a separate Supabase project for Preview. Set `BUSINESS_ID=biz_001`. Set `CORS_ORIGINS` only if browser requests genuinely come from another origin; otherwise leave it empty. Keep the existing Vercel domain and DNS settings unchanged.
5. Rotate any credentials that have ever been committed in the legacy JSON data, including the AI provider key. Removing a value from the current file does not erase it from Git history.

## Safe Import

1. Preserve the source JSON and create a separate, access-controlled backup before migration. Confirm whether Vercel or another host has newer records than this local copy. Do not assume `db.json` is authoritative for production.
2. Start with a fresh development Supabase project. Apply and inspect the schema there first; the migration CLI applies `config/schema.sql` only when `--apply` is supplied.
3. Run `node scripts/migrate-json-to-postgres.js --dry-run`. It checks the required sections, duplicate IDs, business IDs, and chat-message relationships without connecting to or modifying PostgreSQL. Resolve any validation errors before proceeding.
4. Set `DATABASE_URL` to the development database and run `node scripts/migrate-json-to-postgres.js --apply --backup-confirmed`. The confirmation flag is deliberate. Imports are transactional and idempotent: conflicting IDs are skipped, never overwritten or deleted. Admin password/JWT secrets and the Gemini API key are deliberately excluded.
5. Compare all 12 section counts and inspect sample relationships in the development database. Exercise the app against this database before considering production.
6. For production, take a fresh database backup, confirm the source of truth and expected counts with the business owner, then run the same reviewed import against the production connection. Do not run this against production until the separate development validation is complete.

The source JSON remains untouched by the migration CLI. The importer does not merge newer production changes into the local source and intentionally will not update an existing destination row with the same ID.

## Verification

Run `npm install` in `pups`, then `node --check server.js`, `node --check config/database.js`, `node --check ai-engine.js`, and `node --check scripts/migrate-json-to-postgres.js`. For a local isolated chat test, point `PUPS_JSON_FILE` at a temporary copy of the JSON data before starting `npm start`; do not run the isolation test against the working customer database. Set `TEST_ADMIN_CODE` to the test passcode before running `node test_chat_isolation.js`.

In the development deployment, verify customer chat initialization, send/receive, refresh persistence, multiple separate sessions, admin replies, mode changes, puppy/customer/order/payment CRUD, settings persistence, admin authorization, and existing website pages. Verify `/db.json`, `/db.backup.json`, and server source paths return 404. Confirm Vercel requests show no `EROFS` errors and that chat updates arrive through polling. No real payment should be initiated during tests.

## Rollback

Keep the original JSON backup read-only and retain the Supabase backup. If an application rollback is needed after PostgreSQL writes begin, roll back only to an application version that still reads and writes PostgreSQL. Do not redeploy the old JSON-writing implementation: Vercel storage is ephemeral/read-only and would lose writes. To return to JSON storage, first export and reconcile all PostgreSQL changes (including new conversations and messages) into a new protected JSON snapshot, verify counts and relationships, then switch traffic deliberately. Never restore an old snapshot over newer customer, order, payment, puppy, or chat records.

## Production Limitation

This workspace does not have Supabase or Vercel credentials, so no remote schema creation, production data migration, DNS change, deployment, or live-chat verification has been performed. Treat this code as migration tooling for a staged rollout, not as evidence that production has already moved.
