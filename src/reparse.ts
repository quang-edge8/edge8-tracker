import "./env";
import { db } from "./db";
import { parseDelivery } from "./parse";

// Re-run the parser over the whole raw log. Proves the capture-first invariant:
// the parsed tables are recomputable from webhook_deliveries at any time.
// (To prove idempotency: clear the parsed tables, run this, and diff — rows are identical.)
const rows = db
  .prepare("SELECT delivery_id, event, payload FROM webhook_deliveries ORDER BY received_at")
  .all() as Array<{ delivery_id: string; event: string; payload: string }>;

let ok = 0;
let failed = 0;
for (const r of rows) {
  try {
    parseDelivery(r.delivery_id, r.event, JSON.parse(r.payload));
    ok++;
  } catch (err) {
    failed++;
    console.error("reparse failed for", r.delivery_id, err);
  }
}
console.log(`[reparse] ${ok} ok, ${failed} failed, over ${rows.length} deliveries`);
