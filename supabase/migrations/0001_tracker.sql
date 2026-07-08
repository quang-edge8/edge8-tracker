-- edge8-tracker Phase 3 — everything lives in its OWN schema "tracker".
-- This migration only CREATEs inside that schema; it never touches public.*.
--
-- Column types deliberately mirror the SQLite draft: timestamps and JSON payloads
-- are TEXT so the engine reads identical values on both backends (jsonb/timestamptz
-- can come later as views). Time defaults render UTC ISO-8601 with a Z suffix.

create schema if not exists tracker;

-- THE RAW LOG. Every delivery, verbatim, never updated. Everything else is derived.
create table if not exists tracker.webhook_deliveries (
  delivery_id text primary key,
  event       text not null,
  action      text,
  payload     text not null,
  headers     text not null,
  received_at text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  parsed_at   text
);

-- Access events: every app-token call and every beacon. The second capture stream.
create table if not exists tracker.git_access_events (
  id          bigint generated always as identity primary key,
  key_id      text not null,
  repo_path   text,
  verb        text not null default 'unknown',
  kind        text not null,               -- 'token' | 'beacon'
  observed_at text not null,
  received_at text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  raw         text
);

create table if not exists tracker.app_installations (
  installation_id bigint primary key,
  account_login   text not null,
  account_type    text,
  repo_ids        text,                    -- JSON array (text — engine JSON.parses it)
  created_at      text,
  suspended_at    text,
  deleted_at      text,
  raw             text
);

create table if not exists tracker.push_events (
  delivery_id       text primary key references tracker.webhook_deliveries(delivery_id),
  repo_id           bigint not null,
  repo_full         text not null,
  ref               text not null,
  branch            text not null,
  before_sha        text,
  head_sha          text not null,
  forced            integer not null default 0,
  sender_login      text,
  sender_type       text,
  commit_count      integer not null,
  commits_truncated integer not null default 0,
  author_emails     text not null,
  pushed_at         text not null,         -- H1: the webhook received_at
  authored_at       text
);

create table if not exists tracker.pull_requests (
  github_pr_id     bigint primary key,
  repo_id          bigint not null,
  number           integer not null,
  title            text,
  branch           text not null,
  base_branch      text,
  state            text not null,
  merged           integer not null default 0,
  labels           text not null default '[]',
  author_block     text,
  user_login       text,
  opened_at        text,
  merged_at        text,
  closed_at        text,
  raw              text,
  merge_commit_sha text,
  author_member    text,
  orphaned         integer not null default 0
);

create table if not exists tracker.engineer_keys (
  key_id    text primary key,
  key_hash  text not null,                 -- sha256 of the full secret; never the secret
  member    text not null,                 -- company email
  status    text not null default 'active',
  issued_at text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

-- Phase 2 derived tables (written only by the mint engine).
create table if not exists tracker.work_spans (
  id              bigint generated always as identity primary key,
  delivery_id     text not null references tracker.webhook_deliveries(delivery_id),
  member          text,
  repo_id         bigint not null,
  branch          text not null,
  span_start      text,
  span_end        text not null,
  tokens          double precision not null,
  rule            text not null,
  token_class     text not null,
  class_source    text not null,
  pull_request_id bigint,
  flags           text not null default '[]',
  computed_at     text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  unique (delivery_id, member)
);

create table if not exists tracker.capture_flags (
  id          bigint generated always as identity primary key,
  kind        text not null,
  repo_id     bigint,
  ref         text not null default '{}',
  raised_at   text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  resolved_at text,
  unique (kind, ref)
);

create table if not exists tracker.projects (
  repo_id        bigint primary key,
  repo_full      text,
  phase          text not null default 'build',
  default_branch text not null default 'main',
  delivered_at   text
);

-- Serverless is stateless: installation tokens are cached here instead of in memory.
create table if not exists tracker.app_tokens (
  installation_id bigint primary key,
  token           text not null,
  expires_at      text not null,
  updated_at      text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

-- RLS: deny-all by default. The API reaches these tables over a direct Postgres
-- connection as the table owner (owner bypasses RLS); PostgREST/anon/authenticated
-- get nothing because no policies exist and the schema is not exposed.
alter table tracker.webhook_deliveries enable row level security;
alter table tracker.git_access_events  enable row level security;
alter table tracker.app_installations  enable row level security;
alter table tracker.push_events        enable row level security;
alter table tracker.pull_requests      enable row level security;
alter table tracker.engineer_keys      enable row level security;
alter table tracker.work_spans         enable row level security;
alter table tracker.capture_flags      enable row level security;
alter table tracker.projects           enable row level security;
alter table tracker.app_tokens         enable row level security;
