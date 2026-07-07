import { createAppAuth } from "@octokit/auth-app";
import fs from "node:fs";
import { db } from "./db";

// Lazy — do NOT read the key at import time, so the server boots fine before M1.
let _auth: ReturnType<typeof createAppAuth> | null = null;
function appAuth() {
  if (_auth) return _auth;
  const appId = process.env.APP_ID;
  const keyPath = process.env.PRIVATE_KEY_PATH;
  if (!appId || !keyPath || !fs.existsSync(keyPath)) {
    throw new Error(
      "GitHub App not configured — set APP_ID + PRIVATE_KEY_PATH and place the .pem (complete M1)",
    );
  }
  _auth = createAppAuth({ appId, privateKey: fs.readFileSync(keyPath, "utf8") });
  return _auth;
}

// Map "owner/name.git" -> the installation row for that owner.
// Draft assumption: one installation per account. Keyed on account_login.
export function installationForRepoPath(repoPath: string): any | null {
  const owner = (repoPath ?? "").split("/")[0];
  if (!owner) return null;
  return (
    db
      .prepare(
        `SELECT * FROM app_installations
         WHERE account_login = ? AND deleted_at IS NULL
         ORDER BY installation_id LIMIT 1`,
      )
      .get(owner) ?? null
  );
}

// Sign an RS256 JWT with the App key and exchange it for a 60-minute installation token.
export async function mintInstallationToken(installationId: number) {
  const auth = appAuth();
  const res = await auth({ type: "installation", installationId });
  return { token: res.token, expiresAt: res.expiresAt };
}
