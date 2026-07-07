import "./env";
import { db } from "./db";

// Quick capture inspector — no sqlite CLI needed. Run: npm run inspect
const recent = db
  .prepare("SELECT event, action, datetime(received_at) AS at FROM webhook_deliveries ORDER BY received_at DESC LIMIT 10")
  .all();
console.log("\nLast 10 webhook deliveries:");
console.table(recent);

console.log("Row counts:");
for (const t of ["webhook_deliveries", "push_events", "pull_requests", "app_installations", "git_access_events", "engineer_keys"]) {
  const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any;
  console.log(`  ${t.padEnd(20)} ${c.c}`);
}

const inst = db.prepare("SELECT installation_id, account_login, account_type, repo_ids FROM app_installations").all();
if (inst.length) {
  console.log("\nInstallations:");
  console.table(inst);
}

const access = db
  .prepare("SELECT kind, repo_path, verb, datetime(received_at) AS at FROM git_access_events ORDER BY id DESC LIMIT 10")
  .all();
if (access.length) {
  console.log("\nRecent access events (token / beacon):");
  console.table(access);
}
