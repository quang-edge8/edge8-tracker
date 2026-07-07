import { db } from "./db";

// Idempotent parsers: raw delivery -> structured tables.
// INSERT OR REPLACE on natural keys => re-runnable against the raw log with no data loss.
// undefined is coalesced to null everywhere (node:sqlite rejects undefined binds).
export function parseDelivery(id: string, evt: string, p: any): void {
  switch (evt) {
    case "push": {
      const commits: any[] = p.commits ?? [];
      const emails = [
        ...new Set(commits.map((c) => c?.author?.email).filter(Boolean)),
      ];
      db.prepare(
        `INSERT OR REPLACE INTO push_events
          (delivery_id, repo_id, repo_full, ref, branch, before_sha, head_sha, forced,
           sender_login, sender_type, commit_count, commits_truncated, author_emails, pushed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        p.repository?.id ?? null,
        p.repository?.full_name ?? null,
        p.ref ?? null,
        (p.ref ?? "").replace("refs/heads/", ""),
        p.before ?? null,
        p.after ?? null,
        p.forced ? 1 : 0,
        p.sender?.login ?? null,
        p.sender?.type ?? null,
        commits.length,
        // GitHub sends at most 20 commits per push — flag when there were more.
        commits.length >= 20 ? 1 : 0,
        JSON.stringify(emails),
        p.head_commit?.timestamp ?? new Date().toISOString(),
      );
      break;
    }
    case "pull_request": {
      const pr = p.pull_request ?? {};
      const m = /<!--\s*author:\s*(.+?)\s*-->/.exec(pr.body ?? "");
      db.prepare(
        `INSERT OR REPLACE INTO pull_requests
          (github_pr_id, repo_id, number, title, branch, base_branch, state, merged,
           labels, author_block, user_login, opened_at, merged_at, closed_at, raw)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        pr.id ?? null,
        p.repository?.id ?? null,
        pr.number ?? null,
        pr.title ?? null,
        pr.head?.ref ?? null,
        pr.base?.ref ?? null,
        pr.state ?? null,
        pr.merged ? 1 : 0,
        JSON.stringify((pr.labels ?? []).map((l: any) => l.name)),
        m?.[1] ?? null,
        pr.user?.login ?? null,
        pr.created_at ?? null,
        pr.merged_at ?? null,
        pr.closed_at ?? null,
        JSON.stringify(pr),
      );
      break;
    }
    case "installation":
    case "installation_repositories": {
      const inst = p.installation ?? {};
      const repoIds = (p.repositories ?? p.repositories_added ?? []).map(
        (r: any) => r.id,
      );
      db.prepare(
        `INSERT OR REPLACE INTO app_installations
          (installation_id, account_login, account_type, repo_ids, created_at, deleted_at, raw)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        inst.id ?? null,
        inst.account?.login ?? null,
        inst.account?.type ?? null,
        JSON.stringify(repoIds),
        inst.created_at ?? null,
        p.action === "deleted" ? new Date().toISOString() : null,
        JSON.stringify(p),
      );
      break;
    }
    // Any other event: raw is already stored; nothing to derive yet. That is fine.
  }
  db.prepare(
    `UPDATE webhook_deliveries SET parsed_at = datetime('now') WHERE delivery_id = ?`,
  ).run(id);
}
