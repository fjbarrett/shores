# shores — cloud provider status suite

A multi-method cloud-provider uptime checker (`cloudcheck.py` / `check-status.sh`)
plus a Next.js dashboard (`web/`). See `README.md` for the tool/usage details.

## Deployment architecture (live)

Scans run on a home-lab Proxmox box; the dashboard runs on Vercel and reads the
scan data over HTTP from Vercel Blob. No inbound access to the home box.

```
Proxmox LXC 106 "shores" (192.168.0.5)          Vercel
  cron */30  ->  scan.sh                           project "shores"
                 ├─ cloudcheck.py --globe 8         app reads:
                 │    (Globalping authed via          CLOUDCHECK_HISTORY_URL  ─┐
                 │     GLOBALPING_TOKEN)               CLOUDCHECK_SNAPSHOT_URL ─┤
                 └─ upload.mjs (@vercel/blob put) ───────────► Vercel Blob ◄────┘
                      shores/history.jsonl                     store "shores-data"
                      shores/latest.json
```

- **Proxmox host:** `192.168.0.178` (PVE 9.1.1), SSH `root@192.168.0.178` (key `~/.ssh/id_ed25519`).
- **Container:** unprivileged Ubuntu 24.04 LXC **106 `shores`**, DHCP `192.168.0.5`, `onboot=1`.
  Project at `/opt/shores`. Node 20 + Python 3.12. sshd is key-only.
- **Cron:** `*/30 * * * * /opt/shores/scan.sh` → full scan with 8 worldwide Globalping
  probes, then pushes results to Blob. Errors log to `/var/log/shores-scan.err`.
- **Secrets (box only, never in this repo):** `/opt/shores/.env` (mode 600) holds
  `GLOBALPING_TOKEN` and `BLOB_READ_WRITE_TOKEN`. `cloudcheck.py` sends the Globalping
  token as a Bearer header when `GLOBALPING_TOKEN` is set.
- **Vercel:** project `shores` (team `frank-barretts-projects`), Blob store `shores-data`
  (public). Production env vars `CLOUDCHECK_HISTORY_URL` / `CLOUDCHECK_SNAPSHOT_URL` point
  at the stable Blob URLs. Deployment Protection is **off** (public dashboard).
  Live: https://shores-rose.vercel.app
- **App remote-read:** `web/lib/data.ts` fetches from `CLOUDCHECK_*_URL` when set, else
  falls back to the local `results/` filesystem (so `npm run dev` still works locally).
  `POST /api/scan` is disabled in remote mode (scans come from Proxmox).

### Redeploying the app
`cd web && vercel deploy --prod`. The Vercel project framework must stay **Next.js**
(a generic build returns 404 on every route).

### Operating the scanner
- Run a scan now: `ssh root@192.168.0.5 /opt/shores/scan.sh`
- Tail errors: `ssh root@192.168.0.5 tail /var/log/shores-scan.err`
- Change cadence: edit `crontab -e` on the box (mind the Globalping rate limit).

## Git workflow — ALWAYS

- Repo: **public** `github.com/fjbarrett/shores`, default branch `main`.
- **Do proper git operations throughout**: make a focused commit after each logical
  unit of work (don't batch unrelated changes), with a clear message; push when the
  user asks.
- **Never commit secrets**: `.env*`, `web/.vercel/`, the Globalping/Blob tokens, or the
  generated `results/` scan data. These are gitignored — keep it that way.
- `web/` is part of this single repo (it has its own `.gitignore` covering
  `node_modules`, `.next`, `.vercel`, `.env*`).
