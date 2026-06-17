// Server-only: shared Postgres pool for reading scan data from the self-hosted
// DigitalOcean Postgres (db "fivenines"). Returns null when DATABASE_URL is
// unset so local dev can fall back to reading results/ off disk.
import { Pool } from "pg";

// Reuse a single pool across hot-reloads (dev) and warm Fluid Compute instances
// (prod) instead of opening one per request — the droplet is small and shared.
const g = globalThis as unknown as { __fiveninesPool?: Pool };

export function getPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  if (!g.__fiveninesPool) {
    g.__fiveninesPool = new Pool({
      connectionString,
      // The server presents a self-signed cert; encrypt but don't verify the CA.
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return g.__fiveninesPool;
}
