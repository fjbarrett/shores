# shores — cloud provider status suite

Checks whether the major cloud providers are up, using **several independent
methods** per provider, records every scan to **append-only files** for bulk
analysis, and ships a **Next.js dashboard** that aggregates the history and lets
you drill into per-region / per-method detail.

```
shores/
├── cloudcheck.py        # Python checker (recommended) — concurrent, region-aware, multi-vantage
├── check-status.sh      # Bash checker — zero-dependency, same output files
├── lib/                 # bash helpers (common.sh, providers.sh)
├── results/             # written by every scan (gitignore-able)
│   ├── history.jsonl    # one JSON record per provider per scan  ← bulk analysis
│   ├── history.csv      # same rows as CSV                        ← spreadsheets
│   └── runs/<id>.json   # full nested snapshot per scan           ← drill-down detail
└── web/                 # Next.js dashboard (reads results/)
```

## Quick start

```bash
# Python (recommended)
./cloudcheck.py                  # check every provider
./cloudcheck.py aws gcp vercel   # a subset
./cloudcheck.py --globe 8        # also probe from 8 vantage points worldwide
./cloudcheck.py --json           # machine-readable

# Bash (no Python needed)
./check-status.sh
./check-status.sh cloudflare -q

# Dashboard
cd web && npm install && npm run dev   # http://localhost:3000
```

Exit code is `0` when everything is UP, `1` when anything is degraded/down — so
it drops straight into cron, CI, or a healthcheck.

## How the verdict is decided (multiple methods)

Each provider is checked with whichever of these apply, then combined:

| method        | what it does                                                            |
|---------------|-------------------------------------------------------------------------|
| **status feed** | the provider's own status JSON — Statuspage `status.json`, GCP `incidents.json`, AWS `data.json` (authoritative when reachable) |
| **http**      | HTTPS reachability of real API/edge endpoints (any response — even 401/403 — means the edge answered) |
| **dns**       | system resolver **plus** Google / Cloudflare / Quad9 DNS-over-HTTPS      |
| **ipv6**      | a separate TCP/443 handshake over IPv6 (often differs from IPv4)         |
| **regions**   | per-region / per-component health — *X of Y regions up* (see below)      |
| **globe**     | the same HTTP check run from probes worldwide (opt-in, see below)        |

If the status feed says *operational* but you can't reach it, the verdict falls
back to the live probes; if the world can reach it but you can't, it's flagged
as a local/your-IP problem rather than an outage.

## Getting well-rounded results from one IP — and testing from other IPs

A single host only sees one network path. The suite widens that several ways:

- **Multiple resolvers (same IP).** Every DNS check is also run against three
  public DoH resolvers. Because they answer from their own egress locations, you
  see anycast/geo-routing differences a single `getaddrinfo` would hide.
- **Multiple endpoints + IPv4/IPv6 (same IP).** Each provider is probed on
  several real endpoints and over both IP families.
- **Test from other IPs — `--globe`.** Runs the HTTP check from probes around
  the world via the free [Globalping](https://globalping.io) API (no key
  required, rate-limited). This is how you answer *"is it down, or is it just
  my IP?"*
  ```bash
  ./cloudcheck.py --globe 10 --locations "US,DE,JP,AU,BR,IN"
  ```
- **Route through another egress — `--proxy`.** Send the probes through an
  HTTP(S) or SOCKS proxy (e.g. a VPN, a bastion, or Tor):
  ```bash
  ./cloudcheck.py --proxy socks5h://127.0.0.1:9050      # needs `pip install pysocks`
  ./cloudcheck.py --proxy http://user:pass@proxy:8080
  ```
  The `vantage` column records which egress a scan used, so results from
  different IPs can be compared in the same history file.

## Region / component granularity

Beyond a single up/down, providers are broken out into regions/components:

- **Statuspage `components.json`** (Cloudflare, DigitalOcean, Linode, Vercel,
  OCI) — counts operational leaf components.
- **GCP** — products minus those with an open incident.
- **Active probing** (AWS, Alibaba, Tencent) — one request per region against a
  real regional endpoint (`ec2.<region>.amazonaws.com`, `ecs.<region>.aliyuncs.com`, …).

A partial-region outage downgrades the provider to **degraded** even if its
status page still reads green. The dashboard shows *X/Y regions up* per provider
and a global total.

## Output files & bulk analysis

Every scan appends one flat record per provider to `results/history.jsonl` and
`results/history.csv` (identical schema, written by both the Python and bash
tools), and dumps a full nested snapshot to `results/runs/<timestamp>.json`.

Columns: `checked_at, provider, name, state, status_state, status_detail,
http_ok, http_codes, dns_ok, dns_v4, dns_v6, doh_views, ipv6_ok, globe_up,
globe_total, regions_up, regions_total, vantage, note`.

```bash
# uptime % per provider, all of history
jq -rs 'group_by(.provider)[] | {p:.[0].provider,
        up:(map(select(.state=="UP"))|length), n:length}
        | "\(.p): \(100*.up/.n|floor)% (\(.n) scans)"' results/history.jsonl

# or with DuckDB (CSV reads directly)
duckdb -c "SELECT provider, count(*) n,
           round(100.0*sum(state='UP')/count(*),1) uptime_pct
           FROM 'results/history.csv' GROUP BY provider ORDER BY uptime_pct"
```
```python
import pandas as pd
df = pd.read_json("results/history.jsonl", lines=True)
df.pivot_table(index="provider", columns="state", values="checked_at", aggfunc="count")
```

## Dashboard

`web/` is a Next.js 16 app that reads `results/history.jsonl` (and the latest
snapshot for detail). It shows current status, per-provider uptime, region
counts, a scan timeline, and a **Run scan** button that executes `cloudcheck.py`
and re-aggregates. Click any provider card for the full drill-down: every
region/component, each HTTP endpoint + code, all DoH resolver answers, IPv6, and
global probe results.

Point it at a different data location with `CLOUDCHECK_DATA` (path to a
`history.jsonl`) or `CLOUDCHECK_ROOT` (project root holding `results/`).

## Providers

AWS · GCP · Azure · Cloudflare · DigitalOcean · Oracle Cloud (OCI) · Akamai
Linode · Vercel · IBM Cloud · Alibaba Cloud · Tencent Cloud · OVHcloud

## Scheduling

```bash
# every 5 minutes via cron, from the project root
*/5 * * * * cd /path/to/shores && ./cloudcheck.py --json >/dev/null 2>&1
```

## Requirements

- **Python tool:** Python 3.8+ (stdlib only; `pysocks` only for SOCKS proxies).
- **Bash tool:** `bash` + `curl`; uses `jq`/`python3` for richer parsing if present, `dig`/`host`/`nslookup` for DNS.
- **Dashboard:** Node 20.9+.
