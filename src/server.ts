import "./env"; // MUST be first — loads .env before anything reads process.env
import express from "express";
import crypto from "node:crypto";
import { db } from "./db";
import { webhookHandler } from "./webhooks";
import { installationForRepoPath, mintInstallationToken } from "./github";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// --- Health check (M0) ---
app.get("/health", (_req, res) => {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r: any) => r.name);
  res.json({ ok: true, tables });
});

// --- Webhook receiver (M2/M3) — RAW body required for signature verification ---
app.post(
  "/webhooks/github",
  express.raw({ type: "application/json" }),
  webhookHandler,
);

// --- Credential endpoints (M4) ---
// Auth an "x-edge8-key" header: key_id = first two "_"-segments; sha256 the whole
// presented secret and compare to the stored hash. Never store the secret itself.
function findActiveKey(presented: string): any | null {
  const keyId = presented.split("_").slice(0, 2).join("_"); // "e8k_<id>"
  const rec: any = db
    .prepare("SELECT * FROM engineer_keys WHERE key_id = ? AND status = 'active'")
    .get(keyId);
  if (!rec) return null;
  const hash = crypto.createHash("sha256").update(presented).digest("hex");
  return hash === rec.key_hash ? rec : null;
}

function logAccessEvent(
  keyId: string,
  body: any,
  kind: "token" | "beacon",
): void {
  db.prepare(
    `INSERT INTO git_access_events (key_id, repo_path, verb, kind, observed_at, raw)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    keyId,
    body?.path ?? null,
    body?.verb ?? "unknown",
    kind,
    body?.observed_at ?? new Date().toISOString(),
    JSON.stringify(body ?? {}),
  );
}

// POST /app-token — mint a real 60-minute installation token.
app.post("/app-token", express.json(), async (req, res) => {
  const rec = findActiveKey(req.header("x-edge8-key") ?? "");
  if (!rec) return res.status(401).json({ error: "bad key" });

  // LOG THE ACCESS EVENT FIRST — this is the clock-start capture, before we mint.
  logAccessEvent(rec.key_id, req.body, "token");

  const inst = installationForRepoPath(req.body?.path ?? "");
  if (!inst) {
    return res
      .status(404)
      .json({ error: "no installation for repo (install the App / complete M1)" });
  }
  try {
    const { token, expiresAt } = await mintInstallationToken(inst.installation_id);
    res.json({ username: "x-access-token", token, expires_at: expiresAt });
  } catch (err: any) {
    // The access event is already captured; minting just needs a registered App (M1).
    res.status(503).json({ error: "mint failed", detail: String(err?.message ?? err) });
  }
});

// POST /beacon — cache-hit heartbeat. Always 204; never leak whether a key is valid.
app.post("/beacon", express.json(), (req, res) => {
  const rec = findActiveKey(req.header("x-edge8-key") ?? "");
  if (rec) logAccessEvent(rec.key_id, req.body, "beacon");
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
