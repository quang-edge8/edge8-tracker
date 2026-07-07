import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// The store will NOT create the folder — make sure data/ exists first.
const DB_PATH = process.env.DB_PATH ?? "data/capture.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Node 26 built-in SQLite (node:sqlite). API mirrors better-sqlite3:
// db.exec(sql), db.prepare(sql).run(...) / .get(...) / .all().
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL"); // safe concurrent reads while capturing
db.exec("PRAGMA busy_timeout = 5000"); // wait rather than error on brief write contention

// Schema — runs once on boot. IF NOT EXISTS keeps this idempotent.
db.exec(`
-- THE RAW LOG. Every delivery, verbatim, never updated. Everything else is derived from this.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,            -- X-GitHub-Delivery header (unique per delivery)
  event       TEXT NOT NULL,               -- X-GitHub-Event header (push, pull_request, ...)
  action      TEXT,                        -- payload.action, when present
  payload     TEXT NOT NULL,               -- the FULL raw JSON body, exactly as received
  headers     TEXT NOT NULL,               -- JSON of the request headers
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  parsed_at   TEXT                         -- set when a parser has run; null = not yet parsed
);

-- Access events: every app-token call and every beacon. The second capture stream.
CREATE TABLE IF NOT EXISTS git_access_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      TEXT NOT NULL,               -- which engineer key called
  repo_path   TEXT,                        -- e.g. "acme/crm-app.git"
  verb        TEXT NOT NULL DEFAULT 'unknown',  -- pull | push | fetch | clone | unknown
  kind        TEXT NOT NULL,               -- 'token' (mint) | 'beacon' (cache-hit heartbeat)
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw         TEXT                         -- full request body, verbatim
);

-- Parsed installation state (from installation* webhooks).
CREATE TABLE IF NOT EXISTS app_installations (
  installation_id INTEGER PRIMARY KEY,
  account_login   TEXT NOT NULL,           -- the org/user the App is installed on
  account_type    TEXT,                    -- 'Organization' | 'User'
  repo_ids        TEXT,                    -- JSON array of numeric repo ids
  created_at      TEXT,
  suspended_at    TEXT,
  deleted_at      TEXT,                    -- set by installation.deleted = the kill switch
  raw             TEXT
);

-- Parsed pushes (this becomes the mint trigger in Phase 2).
CREATE TABLE IF NOT EXISTS push_events (
  delivery_id       TEXT PRIMARY KEY REFERENCES webhook_deliveries(delivery_id),
  repo_id           INTEGER NOT NULL,      -- NUMERIC id (survives repo renames), not the name
  repo_full         TEXT NOT NULL,         -- "acme/crm-app" for humans
  ref               TEXT NOT NULL,         -- "refs/heads/feature-x"
  branch            TEXT NOT NULL,         -- "feature-x"
  before_sha        TEXT,
  head_sha          TEXT NOT NULL,
  forced            INTEGER NOT NULL DEFAULT 0,   -- 1 if a force-push
  sender_login      TEXT,
  sender_type       TEXT,                  -- 'Bot' when the App itself pushed
  commit_count      INTEGER NOT NULL,
  commits_truncated INTEGER NOT NULL DEFAULT 0,   -- 1 when there were more than 20 commits
  author_emails     TEXT NOT NULL,         -- JSON array of DISTINCT commit author emails
  pushed_at         TEXT NOT NULL
);

-- Parsed pull requests.
CREATE TABLE IF NOT EXISTS pull_requests (
  github_pr_id INTEGER PRIMARY KEY,
  repo_id      INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT,
  branch       TEXT NOT NULL,              -- head ref
  base_branch  TEXT,
  state        TEXT NOT NULL,              -- open | closed
  merged       INTEGER NOT NULL DEFAULT 0,
  labels       TEXT NOT NULL DEFAULT '[]', -- JSON array
  author_block TEXT,                       -- extracted "<!-- author: handle email -->" if present
  user_login   TEXT,                       -- the GitHub account that opened it
  opened_at    TEXT,
  merged_at    TEXT,
  closed_at    TEXT,
  raw          TEXT
);

-- Engineer keys (for authenticating app-token / beacon). Minimal for the draft.
CREATE TABLE IF NOT EXISTS engineer_keys (
  key_id    TEXT PRIMARY KEY,              -- public half, e.g. "e8k_ab12cd34ef56"
  key_hash  TEXT NOT NULL,                 -- sha256 of the full secret; store the hash, never the secret
  member    TEXT NOT NULL,                 -- email/name — good enough for the draft
  status    TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

console.log(`[db] opened ${DB_PATH}`);
