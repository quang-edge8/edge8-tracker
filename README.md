# edge8-tracker — Phase 1 (local GitHub App webhook-capture service)

A local, no-cloud service that **captures** two data streams into a SQLite file:

1. **GitHub webhooks** (push / pull_request / installation / …) — verified and stored **raw** before any parsing.
2. **Git access events** — every `/app-token` mint and every `/beacon` heartbeat (the "clock-start" signal).

Guiding principle: **capture-first, parse-later.** Every webhook is written verbatim to
`webhook_deliveries` *before* parsing. Parsing runs in a `try/catch` and is idempotent
(`INSERT OR REPLACE` on natural keys), so it can be re-run against the raw log with zero data loss.

## Stack

- **Node + Express + TypeScript** (run via `tsx`, no build step)
- **`node:sqlite`** — Node's built-in SQLite (requires **Node ≥ 22**; tested on Node 26). No native module to compile.
- **`@octokit/auth-app`** — App JWT → 60-minute installation token exchange.

## Setup

```bash
npm install
cp .env.example .env      # then fill in APP_ID / WEBHOOK_SECRET after M1 (see below)
npm run seed              # seed the test engineer key
```

`.env` keys: `APP_ID`, `WEBHOOK_SECRET`, `PRIVATE_KEY_PATH`, `PORT`.
**Never commit** `.env`, `keys/`, or `data/` — they are gitignored.

## Run

```bash
npm run dev               # tsx watch (auto-reload)   — or:  npm start
```

Health check: <http://localhost:3000/health> → `{"ok":true,"tables":[...6 tables...]}`.

## Forward GitHub webhooks to localhost (smee)

```bash
# one-time: create a channel at https://smee.io/new, put its URL in the App's Webhook URL
npx smee-client --url https://smee.io/YOUR-CHANNEL --target http://localhost:3000/webhooks/github
```
(`gh webhook forward` from the GitHub CLI is an alternative.)

## Endpoints

| Method | Path | Auth | Does |
|---|---|---|---|
| GET  | `/health` | — | lists the capture tables |
| POST | `/webhooks/github` | `X-Hub-Signature-256` (HMAC of raw body) | verify → store raw → parse → 200 |
| POST | `/app-token` | `x-edge8-key` header | log access event (kind=`token`) → mint 60-min installation token |
| POST | `/beacon` | `x-edge8-key` header | log access event (kind=`beacon`) → always 204 |

### Test the credential endpoints

```bash
# /app-token — logs a git_access_events row, then mints a token (needs a registered App: M1)
curl -s localhost:3000/app-token \
  -H "x-edge8-key: e8k_test0001_supersecretstring" \
  -H "content-type: application/json" \
  -d '{"host":"github.com","path":"YOUR-USER/test-repo.git","verb":"pull"}'

# /beacon — logs a heartbeat, returns 204
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/beacon \
  -H "x-edge8-key: e8k_test0001_supersecretstring" \
  -H "content-type: application/json" \
  -d '{"path":"YOUR-USER/test-repo.git","verb":"pull"}'
```

A returned token really works:
`git clone https://x-access-token:TOKEN@github.com/YOUR-USER/test-repo.git`.

### Seed test key

`npm run seed` inserts `key_id=e8k_test0001` with `key_hash = sha256("e8k_test0001_supersecretstring")`.
Send the **full** string `e8k_test0001_supersecretstring` in the `x-edge8-key` header.

## Re-parse / idempotency

```bash
npm run reparse           # re-runs the parser over every row in webhook_deliveries
```
To prove idempotency: snapshot the parsed tables, clear them, `npm run reparse`, diff — the rows are identical.

## Registering the dev GitHub App (M1 — do this on github.com)

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (personal account is fine).
2. **Webhook URL** = your smee channel URL. **Webhook secret** = a long random string → `.env` `WEBHOOK_SECRET`.
3. **Permissions:** Contents = Read & write, Pull requests = Read & write, Metadata = Read.
4. **Subscribe to events broadly:** push, pull_request, pull_request_review, create, delete, repository, member, label, release.
5. **Generate a private key** → save the `.pem` to `keys/app.private-key.pem`. Note the **App ID** → `.env` `APP_ID`.
6. **Install the App** on one throwaway test repo (fires `installation.created`).

## Layout

```
src/server.ts    route wiring (health + webhooks + app-token + beacon)
src/db.ts        node:sqlite open + schema (6 tables) on boot
src/webhooks.ts  verify → store raw → parse → ack
src/parse.ts     idempotent parsers: raw delivery → tables
src/github.ts    @octokit/auth-app: mint installation tokens
src/env.ts       loads .env
src/seed.ts      seed the test engineer key
src/reparse.ts   re-run the parser over the raw log
data/capture.db  SQLite file (gitignored)
keys/            App private key .pem lives here (gitignored)
```

## Phase 2 handoff notes

### Environment (this dev instance)
- **App ID:** stored in `.env` as `APP_ID`; private key `.pem` lives at `keys/app.private-key.pem` (path only — the key is never committed).
- **Installed on:** test repo `quang-edge8/github-app-track-demo` → captured **installation id `144923721`** (account `quang-edge8`, type User; installation covers the selected repo ids).
- **Webhook secret:** in `.env` as `WEBHOOK_SECRET`, must equal the value entered in the App's *Webhook secret* field. Regenerate + rewrite `.env` with `npm run gen-secret`.

### Subscribed webhook events
`push`, `pull_request`, `pull_request_review`, `create`, `delete`, `repository`, `member`, `label`, `release`
(Repository permissions granted: Contents R/W, Pull requests R/W, Metadata R.)

### Seed engineer key
- `npm run seed` inserts `key_id = e8k_test0001`, `key_hash = sha256("e8k_test0001_supersecretstring")` (only the hash is stored).
- Present the full string `e8k_test0001_supersecretstring` in the `x-edge8-key` header for `/app-token` and `/beacon`.

### Captured fixtures in `data/capture.db` (real GitHub payloads — keep these)
One raw example of each event is preserved in `webhook_deliveries`; parsed rows sit in their tables. Inspect with `npm run inspect`.
| Event | Meaning | Parsed into |
| --- | --- | --- |
| `installation` (created) | App installed | `app_installations` |
| `push` | commits pushed | `push_events` |
| `pull_request` (opened → closed/merged) | PR lifecycle | `pull_requests` (`merged=1` after merge) |
| `create` | branch created | **stored raw only — NOT parsed** |
| access `token` / `beacon` | `/app-token`, `/beacon` calls | `git_access_events` |

### Field notes / gotchas confirmed live (matter for Phase 2)
- **`sender_type`**: pushes made via the *installation token* record `Bot`; pushes/merges made by a human in the GitHub UI record `User`. Work attribution must distinguish these.
- **`create` (and other subscribed events) are captured raw but not parsed** — the parser only derives `push` / `pull_request` / `installation`. Phase 2 can add cases to the `parseDelivery` switch and re-run over the raw log (`npm run reparse`) — no re-capture needed.
- **A merge arrives as two separate deliveries**: a `pull_request` (action `closed`, `merged=1`) *and* a `push` to `main` (sender `User`). Pairing logic should expect both.
- `push` payloads cap at 20 commits → `commits_truncated=1` flags when Phase 2 must re-fetch the full commit list via the compare API.

### What Phase 2 builds
The mint engine (`git_access_events` + `push_events` → token spans / six-minute tenths), PR ↔ session pairing, classification/wallets — then ports storage from `node:sqlite` to Postgres/Supabase. `webhook_deliveries` is the canonical source: everything else is recomputable from it (proven idempotent — `npm run reparse`).
