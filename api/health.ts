import { handleHealth } from "../src/handlers";

export default async function handler(_req: any, res: any) {
  const r = await handleHealth();
  res.status(r.status).json(r.json ?? {});
}
