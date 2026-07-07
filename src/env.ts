import process from "node:process";

// Load .env into process.env (Node built-in, no dependency). Import this FIRST,
// before any module that reads process.env at import time. Safe if .env is absent.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — fall back to the real environment.
}
