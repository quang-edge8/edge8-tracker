// classify() is a pure function — no DB needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classify";

const base = { branch: "feature-x", prLabels: null as string[] | null, projectPhase: "build" };

test("label bug -> maintenance (source label)", () => {
  const r = classify({ ...base, prLabels: ["bug"] });
  assert.deepEqual([r.token_class, r.class_source, r.ambiguous], ["maintenance", "label", false]);
});

test("label chore -> maintenance; label feature -> feature", () => {
  assert.equal(classify({ ...base, prLabels: ["chore"] }).token_class, "maintenance");
  const r = classify({ ...base, prLabels: ["feature"] });
  assert.deepEqual([r.token_class, r.class_source], ["feature", "label"]);
});

test("non-classifying labels are ignored (falls through to branch/phase)", () => {
  const r = classify({ ...base, prLabels: ["documentation", "help wanted"] });
  assert.deepEqual([r.token_class, r.class_source], ["build", "phase"]);
});

test("branch prefixes: fix/ hotfix/ chore/ -> maintenance; feat/ -> feature", () => {
  for (const b of ["fix/x", "hotfix/x", "chore/x"]) {
    const r = classify({ ...base, branch: b });
    assert.deepEqual([r.token_class, r.class_source], ["maintenance", "branch"]);
  }
  const r = classify({ ...base, branch: "feat/x" });
  assert.deepEqual([r.token_class, r.class_source], ["feature", "branch"]);
});

test("labels {bug, feature} -> phase default + ambiguous", () => {
  const r = classify({ ...base, prLabels: ["bug", "feature"] });
  assert.deepEqual([r.token_class, r.class_source, r.ambiguous], ["build", "phase", true]);
});

test("label and branch prefix disagree -> phase default + ambiguous", () => {
  const r = classify({ ...base, branch: "fix/x", prLabels: ["feature"] });
  assert.deepEqual([r.token_class, r.class_source, r.ambiguous], ["build", "phase", true]);
});

test("label and branch prefix agree -> label wins, not ambiguous", () => {
  const r = classify({ ...base, branch: "feat/x", prLabels: ["feature"] });
  assert.deepEqual([r.token_class, r.class_source, r.ambiguous], ["feature", "label", false]);
});

test("phase defaults: build -> build; support/delivered -> maintenance; internal -> internal", () => {
  assert.equal(classify({ ...base }).token_class, "build");
  assert.equal(classify({ ...base, projectPhase: "support" }).token_class, "maintenance");
  assert.equal(classify({ ...base, projectPhase: "delivered" }).token_class, "maintenance");
  const r = classify({ ...base, projectPhase: "internal" });
  assert.deepEqual([r.token_class, r.class_source], ["internal", "phase"]);
});
