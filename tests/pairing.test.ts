process.env.DB_PATH = "data/test-pairing.db";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const H = await import("./helpers");
const { mintForDelivery } = await import("../src/mint");
const { pairRepoBranch, orphanSweep, choosePrForSpan } = await import(
  "../src/pairing"
);
const { toMs } = await import("../src/time");

beforeEach(async () => {
  await H.wipe();
  await H.seedKey();
});

// Real-fixture shape: the branch push (08:01) precedes the PR open (08:03).
// The span must still pair (documented deviation from the brief's literal window).
test("span pushed before the PR opened still pairs to that PR", async () => {
  await H.beacon(H.T("08:00"));
  await H.push("d1", H.T("08:01"));
  await mintForDelivery("d1");
  await H.prRow({
    id: 100, branch: "feature-x", state: "closed", merged: 1,
    opened_at: H.T("08:03"), merged_at: H.T("08:04"), closed_at: H.T("08:04"),
    author_block: "dev dev@local",
  });
  await pairRepoBranch(1, "feature-x");
  await orphanSweep();

  const [s] = await H.spans();
  assert.equal(s.pull_request_id, 100);
  const pr = await H.db.get(
    `SELECT * FROM pull_requests WHERE github_pr_id = 100`,
  );
  assert.equal(pr.orphaned, 0);
  assert.equal(pr.author_member, "dev@local"); // resolved from the author block
});

// Reused branch: the earlier (closed) PR takes spans up to its close; the still-open
// PR only takes what came after — it must never swallow the earlier PR's spans.
test("reused branch: closed PR keeps its spans; open PR takes only later ones", async () => {
  await H.prRow({
    id: 100, branch: "feature-x", state: "closed", merged: 1,
    opened_at: H.T("09:00"), merged_at: H.T("12:00"), closed_at: H.T("12:00"),
  });
  await H.prRow({ id: 200, branch: "feature-x", state: "open", opened_at: H.T("12:30") });

  assert.equal(
    (await choosePrForSpan(1, "feature-x", toMs(H.T("10:00"))))?.github_pr_id,
    100,
  );
  assert.equal(
    (await choosePrForSpan(1, "feature-x", toMs(H.T("13:00"))))?.github_pr_id,
    200,
  );

  await H.beacon(H.T("09:30"));
  await H.push("d1", H.T("10:00"));
  await H.push("d2", H.T("13:00"));
  await mintForDelivery("d1");
  await mintForDelivery("d2");
  await pairRepoBranch(1, "feature-x");

  const s = await H.spans();
  assert.equal(s.find((x) => x.delivery_id === "d1").pull_request_id, 100);
  assert.equal(s.find((x) => x.delivery_id === "d2").pull_request_id, 200);
});

// §6 orphan: a merged PR by a real author with zero paired spans flags loudly.
test("orphaned PR: merged, human author, no spans -> orphaned=1 + orphaned_pr flag", async () => {
  await H.prRow({
    id: 100, branch: "feature-y", state: "closed", merged: 1,
    opened_at: H.T("09:00"), merged_at: H.T("10:00"), closed_at: H.T("10:00"),
    user_login: "human-dev", author_block: "dev dev@local",
  });
  await orphanSweep();

  const pr = await H.db.get(
    `SELECT * FROM pull_requests WHERE github_pr_id = 100`,
  );
  assert.equal(pr.orphaned, 1);
  assert.ok((await H.flagKinds()).includes("orphaned_pr"));
});

test("bot-authored merged PR without spans is NOT orphaned", async () => {
  await H.prRow({
    id: 100, branch: "feature-y", state: "closed", merged: 1,
    opened_at: H.T("09:00"), merged_at: H.T("10:00"), closed_at: H.T("10:00"),
    user_login: "dependabot[bot]",
  });
  await orphanSweep();
  const pr = await H.db.get(
    `SELECT orphaned FROM pull_requests WHERE github_pr_id = 100`,
  );
  assert.equal(pr.orphaned, 0);
  assert.ok(!(await H.flagKinds()).includes("orphaned_pr"));
});

test("human PR without an author block raises missing_author_block", async () => {
  await H.prRow({
    id: 100, branch: "feature-y", state: "open",
    opened_at: H.T("09:00"), user_login: "human-dev", author_block: null,
  });
  await orphanSweep();
  assert.ok((await H.flagKinds()).includes("missing_author_block"));
});

// Same condition never raises twice (UNIQUE kind+ref).
test("flags are deduplicated across repeated sweeps", async () => {
  await H.prRow({
    id: 100, branch: "feature-y", state: "closed", merged: 1,
    opened_at: H.T("09:00"), merged_at: H.T("10:00"), closed_at: H.T("10:00"),
    user_login: "human-dev",
  });
  await orphanSweep();
  await orphanSweep();
  await orphanSweep();
  const n = (await H.flagKinds()).filter((k) => k === "orphaned_pr").length;
  assert.equal(n, 1);
});
