import type { Request, Response } from "express";
import crypto from "node:crypto";
import { db } from "./db";
import { parseDelivery } from "./parse";

// The heart of Phase 1: verify signature -> store raw -> parse (try/catch) -> ack fast.
export function webhookHandler(req: Request, res: Response) {
  const id = req.header("x-github-delivery") ?? "";
  const evt = req.header("x-github-event") ?? "";
  const sig = req.header("x-hub-signature-256") ?? "";
  // express.raw() gives us the exact bytes GitHub signed. Guard in case it didn't apply.
  const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);

  // 1. VERIFY — HMAC-SHA256 of the RAW bytes, constant-time compare.
  const secret = process.env.WEBHOOK_SECRET ?? "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const good =
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!good) return res.status(401).send("bad signature");

  // 2. STORE RAW FIRST — before anything can throw. INSERT OR IGNORE = redelivery-safe.
  const bodyText = raw.toString("utf8");
  let payload: any = {};
  try {
    payload = JSON.parse(bodyText);
  } catch {
    /* keep {} — the raw row is still stored verbatim below */
  }
  db.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, action, payload, headers)
     VALUES (?,?,?,?,?)`,
  ).run(id, evt, payload.action ?? null, bodyText, JSON.stringify(req.headers));

  // 3. PARSE in a try/catch — a parser bug must never lose the raw row or fail the request.
  try {
    parseDelivery(id, evt, payload);
  } catch (err) {
    console.error("parse failed (raw is safe):", id, err);
  }

  // 4. ACK FAST — GitHub retries anything that isn't a quick 2xx.
  res.status(200).send("ok");
}
