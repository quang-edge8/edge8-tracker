process.env.DB_PATH = "data/test-parse.db";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const H = await import("./helpers");
const { parseDelivery } = await import("../src/parse");

beforeEach(async () => H.wipe());

const getInst = (id: number): Promise<any> =>
  H.db.get(`SELECT * FROM app_installations WHERE installation_id = ?`, id);

// H1 — the mint instant is the webhook receipt, not the commit authoring time.
test("H1: push pushed_at = delivery received_at; authored_at keeps the commit time", async () => {
  await H.delivery("d1", "push", H.T("08:04"));
  await parseDelivery("d1", "push", {
    ref: "refs/heads/feature-x",
    before: "aaa",
    after: "bbb",
    repository: { id: 1, full_name: "acme/app" },
    sender: { login: "x", type: "Bot" },
    commits: [],
    head_commit: { timestamp: "2026-07-07T15:04:10+07:00" }, // authored hours earlier, local zone
  });
  const row = await H.db.get(
    `SELECT pushed_at, authored_at FROM push_events WHERE delivery_id = 'd1'`,
  );
  assert.equal(row.pushed_at, H.T("08:04"));
  assert.equal(row.authored_at, "2026-07-07T15:04:10+07:00");
});

// H2 — installation_repositories carries only a delta: merge, never clobber.
test("H2: repositories_added/removed merge with the existing set", async () => {
  await H.delivery("i1", "installation", H.T("09:00"));
  await parseDelivery("i1", "installation", {
    action: "created",
    installation: { id: 5, account: { login: "acme", type: "User" } },
    repositories: [{ id: 10 }, { id: 20 }],
  });
  await H.delivery("i2", "installation_repositories", H.T("09:05"));
  await parseDelivery("i2", "installation_repositories", {
    action: "added",
    installation: { id: 5, account: { login: "acme", type: "User" } },
    repositories_added: [{ id: 30 }],
  });
  assert.deepEqual(JSON.parse((await getInst(5)).repo_ids).sort(), [10, 20, 30]);

  await H.delivery("i3", "installation_repositories", H.T("09:10"));
  await parseDelivery("i3", "installation_repositories", {
    action: "removed",
    installation: { id: 5, account: { login: "acme", type: "User" } },
    repositories_removed: [{ id: 20 }],
  });
  assert.deepEqual(JSON.parse((await getInst(5)).repo_ids).sort(), [10, 30]);
});

// H3 — suspend/unsuspend write suspended_at, and (regression) do not clobber repo_ids.
test("H3: suspend sets suspended_at, unsuspend clears it, repo_ids survive both", async () => {
  await H.delivery("i1", "installation", H.T("09:00"));
  await parseDelivery("i1", "installation", {
    action: "created",
    installation: { id: 5, account: { login: "acme", type: "User" } },
    repositories: [{ id: 10 }],
  });
  await H.delivery("i2", "installation", H.T("10:00"));
  await parseDelivery("i2", "installation", {
    action: "suspend", // suspend payloads typically omit `repositories`
    installation: { id: 5, account: { login: "acme", type: "User" }, suspended_at: H.T("10:00") },
  });
  let row = await getInst(5);
  assert.equal(row.suspended_at, H.T("10:00"));
  assert.deepEqual(JSON.parse(row.repo_ids), [10]); // NOT clobbered to []

  await H.delivery("i3", "installation", H.T("11:00"));
  await parseDelivery("i3", "installation", {
    action: "unsuspend",
    installation: { id: 5, account: { login: "acme", type: "User" } },
  });
  row = await getInst(5);
  assert.equal(row.suspended_at, null);
  assert.deepEqual(JSON.parse(row.repo_ids), [10]);
});

// Pairing writes author_member/orphaned — a later PR webhook must not clobber them
// (the upsert deliberately leaves the derived columns untouched).
test("pull_request reparse preserves derived author_member/orphaned columns", async () => {
  await H.delivery("p1", "pull_request", H.T("08:03"));
  const payload = {
    action: "opened",
    repository: { id: 1, full_name: "acme/app" },
    pull_request: {
      id: 100, number: 1, title: "t", state: "open", merged: false,
      head: { ref: "feature-x" }, base: { ref: "main" },
      labels: [], body: "", user: { login: "human" },
      created_at: H.T("08:03"), merged_at: null, closed_at: null,
      merge_commit_sha: "MSHA",
    },
  };
  await parseDelivery("p1", "pull_request", payload);
  await H.db.run(
    `UPDATE pull_requests SET author_member = 'dev@local', orphaned = 1 WHERE github_pr_id = 100`,
  );
  await parseDelivery("p1", "pull_request", payload); // redelivery / reparse
  const pr = await H.db.get(
    `SELECT author_member, orphaned, merge_commit_sha FROM pull_requests WHERE github_pr_id = 100`,
  );
  assert.equal(pr.author_member, "dev@local");
  assert.equal(pr.orphaned, 1);
  assert.equal(pr.merge_commit_sha, "MSHA");
});

// Malformed payloads must not throw (the raw row is already safe; parse just skips).
test("malformed pull_request / installation payloads do not throw", async () => {
  await H.delivery("m1", "pull_request", H.T("08:00"));
  await assert.doesNotReject(() => parseDelivery("m1", "pull_request", {}));
  await H.delivery("m2", "installation", H.T("08:01"));
  await assert.doesNotReject(() => parseDelivery("m2", "installation", {}));
});
