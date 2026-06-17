// Push scan data to the self-hosted DigitalOcean Postgres so the dashboard can
// read it. Run after each scan. Idempotent + self-seeding: re-running backfills
// anything missing.
//   table history    flat per-provider rows (from results/history.jsonl)
//   table snapshots  full per-run snapshot (from results/runs/<id>.json)
// (Region timelines are derived on read from the last 90 snapshots — no longer
//  precomputed here.)
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const root = '/opt/shores';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false }, // server uses a self-signed cert
  max: 2,
});

try {
  // 1) flat history rows — one batched upsert of the whole file (small),
  //    ON CONFLICT DO NOTHING so re-runs only add genuinely new rows.
  const histText = await readFile(path.join(root, 'results/history.jsonl'), 'utf8').catch(() => '');
  const rows = [];
  for (const line of histText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r.checked_at && r.provider) rows.push(r);
    } catch { /* skip malformed line */ }
  }
  let histNew = 0;
  if (rows.length) {
    const res = await pool.query(
      `INSERT INTO history (checked_at, provider, row)
       SELECT x->>'checked_at', x->>'provider', x
       FROM jsonb_array_elements($1::jsonb) AS x
       ON CONFLICT (checked_at, provider) DO NOTHING`,
      [JSON.stringify(rows)]
    );
    histNew = res.rowCount;
  }

  // 2) run snapshots — upsert the latest always, plus any of the last 90 not
  //    yet stored (keeps the DB in sync / self-seeds without re-sending all 90).
  const runsDir = path.join(root, 'results/runs');
  const runFiles = (await readdir(runsDir)).filter(f => f.endsWith('.json')).sort();
  const recent = runFiles.slice(-90);
  const { rows: existing } = await pool.query('SELECT checked_at FROM snapshots');
  const have = new Set(existing.map(r => r.checked_at));
  const latestFile = recent.at(-1); // filename ids use dashes; checked_at uses colons
  let snapN = 0;
  for (const f of recent) {
    let data;
    try { data = JSON.parse(await readFile(path.join(runsDir, f), 'utf8')); } catch { continue; }
    if (!data.checked_at) continue;
    if (have.has(data.checked_at) && f !== latestFile) continue; // stored already; only refresh newest
    await pool.query(
      `INSERT INTO snapshots (checked_at, vantage, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (checked_at) DO UPDATE SET vantage = EXCLUDED.vantage, data = EXCLUDED.data`,
      [data.checked_at, data.vantage ?? null, JSON.stringify(data)]
    );
    snapN++;
  }

  console.log(`history: +${histNew} new rows (of ${rows.length}); snapshots upserted: ${snapN}`);
} finally {
  await pool.end();
}
