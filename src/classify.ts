// Classification (brief §7): label -> branch prefix -> project phase.
// Pure function — no DB access; callers pass the PR labels + project phase in.

export type TokenClass = "build" | "maintenance" | "feature" | "internal";
export type ClassSource = "label" | "branch" | "phase" | "human";

export interface ClassResult {
  token_class: TokenClass;
  class_source: ClassSource;
  ambiguous: boolean; // caller raises 'ambiguous_class'
}

function labelClassOf(labels: string[]): TokenClass | "conflict" | null {
  const set = new Set<TokenClass>();
  for (const l of labels.map((x) => x.toLowerCase())) {
    if (l === "bug" || l === "chore") set.add("maintenance");
    if (l === "feature") set.add("feature");
  }
  if (set.size === 0) return null;
  if (set.size === 1) return [...set][0];
  return "conflict"; // labels are {bug, feature} — a human resolves it later
}

function branchClassOf(branch: string): TokenClass | null {
  const b = branch.toLowerCase();
  if (b.startsWith("fix/") || b.startsWith("hotfix/") || b.startsWith("chore/"))
    return "maintenance";
  if (b.startsWith("feat/")) return "feature";
  return null;
}

function phaseDefault(phase: string): TokenClass {
  if (phase === "internal") return "internal";
  if (phase === "support" || phase === "delivered") return "maintenance";
  return "build"; // phase 'build' (and anything unknown) capitalises as build
}

export function classify(opts: {
  branch: string;
  prLabels: string[] | null; // null = no PR known yet
  projectPhase: string;
}): ClassResult {
  const label = opts.prLabels ? labelClassOf(opts.prLabels) : null;
  const branch = branchClassOf(opts.branch ?? "");

  if (label === "conflict")
    return { token_class: phaseDefault(opts.projectPhase), class_source: "phase", ambiguous: true };
  if (label && branch && label !== branch)
    return { token_class: phaseDefault(opts.projectPhase), class_source: "phase", ambiguous: true };
  if (label) return { token_class: label, class_source: "label", ambiguous: false };
  if (branch) return { token_class: branch, class_source: "branch", ambiguous: false };
  return { token_class: phaseDefault(opts.projectPhase), class_source: "phase", ambiguous: false };
}
