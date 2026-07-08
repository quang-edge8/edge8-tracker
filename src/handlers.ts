import crypto from "node:crypto";
import { db } from "./db";
import { parseDelivery } from "./parse";
import { postPushCapture } from "./mint";
import { onPullRequestWebhook } from "./pairing";
import { installationForRepoPath, mintInstallationToken } from "./github";

// Framework-agnostic request handlers — the local Express server (src/server.ts)
// and the Vercel functions (api/*) both delegate here, so behaviour is identical.

export interface HandlerResult {
  status: number;
  json?: unknown;
  text?: string;
}

// --- Webhook: verify signature -> store raw -> parse/mint/pair -> ack fast ---
export async function handleWebhook(input: {
  id: string;
  evt: string;
  sig: string;
  raw: Buffer;
  headers: Record<string, unknown>;
}): Promise<HandlerResult> {
  const { id, evt, sig, raw, headers } = input;

  // 1. VERIFY — HMAC-SHA256 of the RAW bytes, constant-time compare.
  // Fail CLOSED if the secret is missing: never HMAC with an empty key, or anyone
  // could forge a valid signature when the env var is unset/misconfigured.
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error("WEBHOOK_SECRET not configured — rejecting webhook");
    return { status: 401, text: "bad signature" };
  }
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const good =
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!good) return { status: 401, text: "bad signature" };

  // 2. STORE RAW FIRST — before anything can throw. ON CONFLICT = redelivery-safe.
  const bodyText = raw.toString("utf8");
  let payload: any = {};
  try {
    payload = JSON.parse(bodyText);
  } catch {
    /* keep {} — the raw row is still stored verbatim below */
  }
  await db.run(
    `INSERT INTO webhook_deliveries (delivery_id, event, action, payload, headers)
     VALUES (?,?,?,?,?) ON CONFLICT (delivery_id) DO NOTHING`,
    id,
    evt,
    payload.action ?? null,
    bodyText,
    JSON.stringify(headers),
  );

  // 3. PARSE (+ mint/pair) in a try/catch — a bug here must never lose the raw row
  // or fail the request. Everything derived is recomputable (reparse + remint).
  try {
    await parseDelivery(id, evt, payload);
    if (evt === "push") await postPushCapture(id);
    else if (evt === "pull_request") await onPullRequestWebhook(payload);
  } catch (err) {
    console.error("parse/mint failed (raw is safe):", id, err);
  }

  // 4. ACK FAST.
  return { status: 200, text: "ok" };
}

// --- Key auth: key_id = first two "_"-segments; compare sha256(full secret) ---
async function findActiveKey(presented: string): Promise<any | null> {
  const keyId = presented.split("_").slice(0, 2).join("_"); // "e8k_<id>"
  const rec = await db.get(
    `SELECT * FROM engineer_keys WHERE key_id = ? AND status = 'active'`,
    keyId,
  );
  if (!rec) return null;
  // Constant-time compare (both sides are 64-char sha256 hex) — no early-exit
  // timing leak on the stored hash.
  const a = Buffer.from(crypto.createHash("sha256").update(presented).digest("hex"));
  const b = Buffer.from(rec.key_hash ?? "");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? rec : null;
}

async function logAccessEvent(
  keyId: string,
  body: any,
  kind: "token" | "beacon",
): Promise<void> {
  await db.run(
    `INSERT INTO git_access_events (key_id, repo_path, verb, kind, observed_at, raw)
     VALUES (?,?,?,?,?,?)`,
    keyId,
    body?.path ?? null,
    body?.verb ?? "unknown",
    kind,
    body?.observed_at ?? new Date().toISOString(),
    JSON.stringify(body ?? {}),
  );
}

// --- POST /app-token — mint a real 60-minute installation token ---
export async function handleAppToken(
  presented: string,
  body: any,
): Promise<HandlerResult> {
  const rec = await findActiveKey(presented);
  if (!rec) return { status: 401, json: { error: "bad key" } };

  // LOG THE ACCESS EVENT FIRST — this is the clock-start capture, before we mint.
  await logAccessEvent(rec.key_id, body, "token");

  const inst = await installationForRepoPath(body?.path ?? "");
  if (!inst) {
    // 404 tells the credential helper "not a tracked repo" -> it stays silent and
    // git falls through to the engineer's next credential helper.
    return { status: 404, json: { error: "no installation for repo" } };
  }
  try {
    const { token, expiresAt } = await mintInstallationToken(
      Number(inst.installation_id),
    );
    return {
      status: 200,
      json: { username: "x-access-token", token, expires_at: expiresAt },
    };
  } catch (err: any) {
    return {
      status: 503,
      json: { error: "mint failed", detail: String(err?.message ?? err) },
    };
  }
}

// --- POST /beacon — cache-hit heartbeat. Always 204; never leak key validity ---
export async function handleBeacon(
  presented: string,
  body: any,
): Promise<HandlerResult> {
  const rec = await findActiveKey(presented);
  if (rec) await logAccessEvent(rec.key_id, body, "beacon");
  return { status: 204 };
}

// --- GET /health ---
export async function handleHealth(): Promise<HandlerResult> {
  return { status: 200, json: { ok: true, backend: db.kind, tables: await db.tables() } };
}
