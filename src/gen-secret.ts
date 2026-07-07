import crypto from "node:crypto";
import fs from "node:fs";

// Generate a strong webhook secret, write it into .env, and print it so you can paste
// the SAME value into the GitHub App's "Webhook secret" field. Run: npm run gen-secret
const secret = crypto.randomBytes(24).toString("hex");
const PATH = ".env";
let env = fs.existsSync(PATH) ? fs.readFileSync(PATH, "utf8") : "";
if (/^WEBHOOK_SECRET=.*/m.test(env)) {
  env = env.replace(/^WEBHOOK_SECRET=.*/m, `WEBHOOK_SECRET=${secret}`);
} else {
  env += (env === "" || env.endsWith("\n") ? "" : "\n") + `WEBHOOK_SECRET=${secret}\n`;
}
fs.writeFileSync(PATH, env);
console.log("\n.env WEBHOOK_SECRET updated. Paste this EXACT value into the GitHub App 'Webhook secret' field:\n");
console.log("  " + secret + "\n");
