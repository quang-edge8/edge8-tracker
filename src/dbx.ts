// The database facade every engine module talks to. Two implementations:
//   db-sqlite.ts — node:sqlite, local dev + fast tests
//   db-pg.ts     — postgres.js -> Supabase (schema "tracker"), Vercel production
// All engine SQL is written in the portable subset both understand:
// standard `INSERT ... ON CONFLICT (...) DO UPDATE/DO NOTHING` and `?` placeholders.

export interface Dbx {
  kind: "sqlite" | "postgres";
  run(sql: string, ...params: unknown[]): Promise<void>;
  get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...params: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tables(): Promise<string[]>;
}

export const clean = (p: unknown): unknown => (p === undefined ? null : p);
