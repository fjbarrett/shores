#!/usr/bin/env python3
"""cloudcheck — multi-method, multi-vantage up/down checker for major cloud providers.

Single file, stdlib only (SOCKS proxying optionally uses PySocks).

For each provider it combines several independent signals:

  1. status feed   the provider's own status JSON (Statuspage / GCP / AWS)
  2. http          HTTPS reachability of real API/edge endpoints (IPv4 + IPv6)
  3. dns           system resolver + several public DNS-over-HTTPS resolvers
  4. globe         (optional) the same HTTP check run from probes worldwide
                   via the free Globalping API — this is how you escape the
                   "is it down, or is it just my IP?" trap from a single host.

Examples:
  ./cloudcheck.py                      # all providers, local methods
  ./cloudcheck.py aws gcp vercel       # a subset
  ./cloudcheck.py --globe 8            # also probe from 8 worldwide vantage points
  ./cloudcheck.py --proxy socks5h://127.0.0.1:9050   # route through Tor / another egress
  ./cloudcheck.py --json               # machine-readable output

Exit code: 0 = all UP, 1 = something DEGRADED/DOWN.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

UA = "cloudcheck/1.0 (+status probe)"

# --------------------------------------------------------------------------- #
# Provider table
# --------------------------------------------------------------------------- #
# Curated region lists for providers that expose a per-region API endpoint we
# can probe directly (their status feeds don't break out regions). Each region's
# endpoint answering at all -> that region is reachable from here.
AWS_REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1",
               "sa-east-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1",
               "eu-north-1", "eu-south-1", "ap-south-1", "ap-southeast-1",
               "ap-southeast-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
               "ap-east-1", "me-south-1", "af-south-1"]
OCI_REGIONS = ["us-ashburn-1", "us-phoenix-1", "us-sanjose-1", "ca-toronto-1",
               "ca-montreal-1", "sa-saopaulo-1", "uk-london-1", "eu-frankfurt-1",
               "eu-amsterdam-1", "eu-zurich-1", "eu-paris-1", "ap-tokyo-1",
               "ap-osaka-1", "ap-seoul-1", "ap-singapore-1", "ap-sydney-1",
               "ap-mumbai-1", "me-dubai-1", "me-jeddah-1"]
ALI_REGIONS = ["cn-hangzhou", "cn-beijing", "cn-shanghai", "cn-shenzhen", "cn-hongkong",
               "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-5",
               "ap-south-1", "ap-northeast-1", "us-east-1", "us-west-1",
               "eu-central-1", "eu-west-1", "me-east-1"]
TENCENT_REGIONS = ["ap-guangzhou", "ap-shanghai", "ap-beijing", "ap-chengdu",
                   "ap-nanjing", "ap-hongkong", "ap-singapore", "ap-bangkok",
                   "ap-jakarta", "ap-tokyo", "ap-seoul", "ap-mumbai",
                   "na-siliconvalley", "na-ashburn", "sa-saopaulo", "eu-frankfurt"]
# Azure has no public per-region status feed; probe per-region Cognitive Services
# edge endpoints instead (any HTTP response = that region's edge answered).
AZURE_REGIONS = ["eastus", "eastus2", "westus", "westus2", "westus3", "centralus",
                 "southcentralus", "northcentralus", "westcentralus", "canadacentral",
                 "brazilsouth", "westeurope", "northeurope", "uksouth", "francecentral",
                 "germanywestcentral", "switzerlandnorth", "norwayeast", "swedencentral",
                 "polandcentral", "italynorth", "uaenorth", "qatarcentral",
                 "southafricanorth", "eastasia", "southeastasia", "japaneast", "japanwest",
                 "koreacentral", "australiaeast", "centralindia", "southindia"]

# method (top-level verdict source):
#   statuspage  Atlassian Statuspage v2 (.status.indicator)
#   gcp         status.cloud.google.com incidents.json
#   aws         AWS Health feed (health.aws.amazon.com/public/currentevents)
#   rss         RSS/Atom incident feed -> open <item>/<entry> count drives verdict
#   reach       no machine-readable feed -> verdict from live probes only
# regions (per-region/component granularity, optional):
#   {"kind":"components","url":…}   Statuspage components.json (leaf components)
#   {"kind":"gcp"}                  products.json minus products with open incidents
#   {"kind":"probe","tmpl":…,"list":[…]}  probe one endpoint per region
PROVIDERS = [
    dict(key="aws", name="Amazon Web Services", method="aws",
         status="https://health.aws.amazon.com/public/currentevents",
         reach=["https://aws.amazon.com", "https://s3.amazonaws.com",
                "https://ec2.us-east-1.amazonaws.com"],
         dns=["aws.amazon.com", "s3.amazonaws.com"],
         page="https://health.aws.amazon.com/health/status",
         regions={"kind": "probe", "tmpl": "https://ec2.{}.amazonaws.com", "list": AWS_REGIONS}),
    dict(key="gcp", name="Google Cloud Platform", method="gcp",
         status="https://status.cloud.google.com/incidents.json",
         reach=["https://cloud.google.com", "https://storage.googleapis.com",
                "https://compute.googleapis.com"],
         dns=["cloud.google.com", "storage.googleapis.com"],
         page="https://status.cloud.google.com",
         regions={"kind": "gcp"}),
    dict(key="azure", name="Microsoft Azure", method="rss",
         status="https://azure.status.microsoft/en-us/status/feed/",
         reach=["https://management.azure.com", "https://azure.microsoft.com",
                "https://login.microsoftonline.com"],
         dns=["management.azure.com", "azure.microsoft.com"],
         page="https://status.azure.com",
         regions={"kind": "probe", "tmpl": "https://{}.api.cognitive.microsoft.com", "list": AZURE_REGIONS}),
    dict(key="cloudflare", name="Cloudflare", method="statuspage",
         status="https://www.cloudflarestatus.com/api/v2/status.json",
         reach=["https://www.cloudflare.com", "https://api.cloudflare.com",
                "https://1.1.1.1"],
         dns=["www.cloudflare.com", "api.cloudflare.com"],
         page="https://www.cloudflarestatus.com",
         regions={"kind": "components", "url": "https://www.cloudflarestatus.com/api/v2/components.json"}),
    dict(key="digitalocean", name="DigitalOcean", method="statuspage",
         status="https://status.digitalocean.com/api/v2/status.json",
         reach=["https://api.digitalocean.com", "https://www.digitalocean.com"],
         dns=["api.digitalocean.com", "www.digitalocean.com"],
         page="https://status.digitalocean.com",
         regions={"kind": "components", "url": "https://status.digitalocean.com/api/v2/components.json"}),
    dict(key="oracle", name="Oracle Cloud (OCI)", method="statuspage",
         status="https://ocistatus.oraclecloud.com/api/v2/status.json",
         reach=["https://cloud.oracle.com", "https://www.oracle.com/cloud"],
         dns=["cloud.oracle.com", "objectstorage.us-ashburn-1.oraclecloud.com"],
         page="https://ocistatus.oraclecloud.com",
         regions={"kind": "probe", "tmpl": "https://objectstorage.{}.oraclecloud.com", "list": OCI_REGIONS}),
    dict(key="linode", name="Akamai Linode", method="statuspage",
         status="https://status.linode.com/api/v2/status.json",
         reach=["https://api.linode.com", "https://www.linode.com"],
         dns=["api.linode.com", "www.linode.com"],
         page="https://status.linode.com",
         regions={"kind": "components", "url": "https://status.linode.com/api/v2/components.json"}),
    dict(key="vercel", name="Vercel", method="statuspage",
         status="https://www.vercel-status.com/api/v2/status.json",
         reach=["https://vercel.com", "https://api.vercel.com"],
         dns=["vercel.com", "api.vercel.com"],
         page="https://www.vercel-status.com",
         regions={"kind": "components", "url": "https://www.vercel-status.com/api/v2/components.json"}),
    dict(key="ibm", name="IBM Cloud", method="reach",
         status=None,
         reach=["https://cloud.ibm.com", "https://www.ibm.com/cloud"],
         dns=["cloud.ibm.com", "iam.cloud.ibm.com"],
         page="https://cloud.ibm.com/status", regions=None),
    dict(key="alibaba", name="Alibaba Cloud", method="reach",
         status=None,
         reach=["https://www.alibabacloud.com", "https://ecs.ap-southeast-1.aliyuncs.com"],
         dns=["www.alibabacloud.com", "ecs.ap-southeast-1.aliyuncs.com"],
         page="https://status.alibabacloud.com",
         regions={"kind": "probe", "tmpl": "https://ecs.{}.aliyuncs.com", "list": ALI_REGIONS}),
    dict(key="tencent", name="Tencent Cloud", method="reach",
         status=None,
         reach=["https://intl.cloud.tencent.com", "https://cvm.ap-singapore.tencentcloudapi.com"],
         dns=["intl.cloud.tencent.com", "cvm.ap-singapore.tencentcloudapi.com"],
         page="https://status.cloud.tencent.com",
         regions={"kind": "probe", "tmpl": "https://cvm.{}.tencentcloudapi.com", "list": TENCENT_REGIONS}),
    dict(key="ovh", name="OVHcloud", method="reach",
         status=None,
         reach=["https://www.ovhcloud.com", "https://api.ovh.com", "https://ca.api.ovh.com"],
         dns=["www.ovhcloud.com", "api.ovh.com"],
         page="https://status.ovhcloud.com", regions=None),
    dict(key="meta", name="Meta Platforms", method="reach",
         status=None,
         reach=["https://www.facebook.com", "https://graph.facebook.com",
                "https://www.instagram.com"],
         dns=["facebook.com", "graph.facebook.com"],
         page="https://metastatus.com", regions=None),
    dict(key="bytedance", name="ByteDance (Volcano Engine)", method="reach",
         status=None,
         reach=["https://www.volcengine.com", "https://open.volcengineapi.com",
                "https://www.byteplus.com"],
         dns=["www.volcengine.com", "open.volcengineapi.com"],
         page="https://www.volcengine.com", regions=None),
    dict(key="anthropic", name="Anthropic (Claude)", method="statuspage",
         status="https://status.claude.com/api/v2/status.json",
         reach=["https://api.anthropic.com", "https://www.anthropic.com"],
         dns=["api.anthropic.com", "www.anthropic.com"],
         page="https://status.claude.com",
         regions={"kind": "components", "url": "https://status.claude.com/api/v2/components.json"}),
    dict(key="openai", name="OpenAI", method="statuspage",
         status="https://status.openai.com/api/v2/status.json",
         reach=["https://api.openai.com", "https://openai.com"],
         dns=["api.openai.com", "openai.com"],
         page="https://status.openai.com",
         regions={"kind": "components", "url": "https://status.openai.com/api/v2/components.json"}),
]

# Public DNS-over-HTTPS resolvers. Querying several from one machine surfaces
# anycast / geo-routing differences you would otherwise never see from a single
# IP — each resolver answers from its own egress location.
DOH = {
    "google":     "https://dns.google/resolve",
    "cloudflare": "https://cloudflare-dns.com/dns-query",
    "quad9":      "https://dns.quad9.net:5053/dns-query",
}

# --------------------------------------------------------------------------- #
# colour
# --------------------------------------------------------------------------- #
class C:
    enabled = sys.stdout.isatty() and "NO_COLOR" not in os.environ
    @classmethod
    def _w(cls, code, s):
        return f"\033[{code}m{s}\033[0m" if cls.enabled else s
    @classmethod
    def red(cls, s):    return cls._w("31", s)
    @classmethod
    def green(cls, s):  return cls._w("32", s)
    @classmethod
    def yellow(cls, s): return cls._w("33", s)
    @classmethod
    def dim(cls, s):    return cls._w("2", s)
    @classmethod
    def bold(cls, s):   return cls._w("1", s)

STATE_FMT = {
    "UP": ("●", C.green), "DEGRADED": ("◐", C.yellow),
    "DOWN": ("○", C.red), "UNKNOWN": ("?", C.dim),
}

# --------------------------------------------------------------------------- #
# HTTP / DNS / TCP primitives
# --------------------------------------------------------------------------- #
def build_opener(proxy):
    """urllib opener, optionally via an HTTP(S) proxy. SOCKS is handled globally
    by monkeypatching socket in main() (so DNS/TCP probes travel the proxy too)."""
    handlers = []
    if proxy and proxy.split("://", 1)[0] in ("http", "https"):
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    elif proxy:
        handlers.append(urllib.request.ProxyHandler({}))  # SOCKS already patched in
    ctx = ssl.create_default_context()
    handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


def http_probe(url, opener, timeout):
    """Return (ok, code, note). Any HTTP response — even 401/403/404 — means the
    edge answered, which is what reachability is. Only a transport failure is
    'unreachable'."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=timeout) as r:
            return True, r.status, ""
    except urllib.error.HTTPError as e:
        return True, e.code, ""                       # responded -> reachable
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        # some hosts reject HEAD; retry GET once before declaring it dead
        try:
            req2 = urllib.request.Request(url, method="GET", headers={"User-Agent": UA})
            with opener.open(req2, timeout=timeout) as r:
                return True, r.status, ""
        except urllib.error.HTTPError as e2:
            return True, e2.code, ""
        except Exception:
            return False, 0, str(reason)
    except Exception as e:
        return False, 0, str(e)


def http_get(url, opener, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with opener.open(req, timeout=timeout) as r:
        data = r.read()
    # Some feeds (notably the AWS Health feed) are served as UTF-16 with a BOM.
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", "replace")
    return data.decode("utf-8", "replace")


def resolve_system(host, timeout):
    """Return (set(ipv4), set(ipv6))."""
    v4, v6 = set(), set()
    try:
        socket.setdefaulttimeout(timeout)
        for fam, _, _, _, sa in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP):
            (v4 if fam == socket.AF_INET else v6).add(sa[0])
    except Exception:
        pass
    return v4, v6


def resolve_doh(host, name, url, opener, timeout):
    """Query one DoH resolver, return sorted list of A/AAAA addresses (or [])."""
    q = f"{url}?name={host}&type=A&ct=application/dns-json"
    req = urllib.request.Request(q, headers={"User-Agent": UA, "Accept": "application/dns-json"})
    try:
        with opener.open(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        return sorted({a["data"] for a in data.get("Answer", []) if a.get("type") in (1, 28)})
    except Exception:
        return []


def tcp_connect(host, port, family, timeout):
    try:
        infos = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)
    except Exception:
        return False
    for fam, kind, proto, _, sa in infos:
        try:
            s = socket.socket(fam, kind, proto)
            s.settimeout(timeout)
            s.connect(sa)
            s.close()
            return True
        except Exception:
            continue
    return False


# --------------------------------------------------------------------------- #
# status-feed parsers
# --------------------------------------------------------------------------- #
def parse_statuspage(body):
    d = json.loads(body)
    s = d.get("status", {}) or {}
    ind = (s.get("indicator") or "").lower()
    desc = s.get("description") or ""
    state = {"none": "UP", "": "UP", "operational": "UP",
             "minor": "DEGRADED", "maintenance": "DEGRADED",
             "major": "DOWN", "critical": "DOWN"}.get(ind, "UNKNOWN")
    return state, desc or state, f"statuspage api: {ind or '?'} — {desc}"


def parse_gcp(body):
    incidents = json.loads(body)
    rank = {"low": 1, "medium": 2, "high": 3}
    ongoing = [i for i in incidents if not i.get("end")]
    if not ongoing:
        return "UP", "No active incidents", "incidents.json: 0 open incidents"
    sev = max((i.get("severity") or "").lower() for i in ongoing) if ongoing else ""
    worst = max(rank.get((i.get("severity") or "").lower(), 0) for i in ongoing)
    state = "DOWN" if worst >= 3 else "DEGRADED"
    sev_name = {3: "high", 2: "medium", 1: "low"}.get(worst, "unknown")
    return state, f"{len(ongoing)} active incident(s), max severity {sev_name}", \
        f"incidents.json: {len(ongoing)} open, severity {sev_name}"


# AWS leaves resolved events in its public feed for weeks, so "feed not empty"
# is not "currently broken" — only events updated within this window are active.
AWS_ACTIVE_WINDOW = 36 * 3600


def parse_aws(body):
    """AWS Health feed (health.aws.amazon.com/public/currentevents). The modern
    feed is a flat list of events; the legacy data.json nested them under
    'current'. status codes: 0 normal · 1 informational · 2 degradation · 3 disruption."""
    def _i(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0

    d = json.loads(body)
    events = d if isinstance(d, list) else (d.get("current") or [])
    if not events:
        return "UP", "No open events", "health feed: 0 events"

    now = time.time()
    def last_update(e):
        ts = [_i(e.get("date"))] + [_i(le.get("timestamp")) for le in (e.get("event_log") or [])]
        return max(ts) if ts else 0

    active = [e for e in events if now - last_update(e) <= AWS_ACTIVE_WINDOW]
    disrupt = [e for e in active if str(e.get("status")) in ("2", "3")]
    if not disrupt:
        line = f"health feed: {len(active)} recent notice(s), 0 disruptions" if active \
            else "health feed: no active events"
        return "UP", "No active disruptions", line
    worst = max(_i(e.get("status")) for e in disrupt)
    state = "DOWN" if worst >= 3 else "DEGRADED"
    svcs = ", ".join(sorted({(e.get("service_name") or e.get("service") or "?") for e in disrupt})[:3])
    return state, f"{len(disrupt)} active issue(s): {svcs}", \
        f"health feed: {len(disrupt)} disruption(s), max status {worst}"


def parse_rss(body):
    """RSS/Atom incident feed (e.g. Azure). An empty feed means all-clear; each
    open <item>/<entry> is an active incident."""
    low = body.lower()
    n = low.count("<item") + low.count("<entry")
    if n == 0:
        return "UP", "No active incidents", "rss feed: 0 open items"
    return "DEGRADED", f"{n} active incident(s)", f"rss feed: {n} open item(s)"


def status_feed(prov, opener, timeout):
    """Return (state, detail, line). state UNKNOWN if the feed can't be read."""
    method, url = prov["method"], prov["status"]
    if method == "reach" or not url:
        return "n/a", "no machine-readable feed", f"no public status api — see {prov['page']}"
    try:
        body = http_get(url, opener, timeout)
    except Exception as e:
        return "UNKNOWN", "status feed unreachable", f"{method} feed: no response ({str(e)[:40]})"
    try:
        return {"statuspage": parse_statuspage, "gcp": parse_gcp,
                "aws": parse_aws, "rss": parse_rss}[method](body)
    except Exception as e:
        return "UNKNOWN", "could not parse feed", f"{method} feed: parse error ({str(e)[:40]})"


# --------------------------------------------------------------------------- #
# Globalping — run the HTTP check from probes worldwide (free, no key needed).
# This is the answer to "how do I test from other IPs?".
# --------------------------------------------------------------------------- #
GLOBALPING = "https://api.globalping.io/v1/measurements"


def globalping(host, opener, timeout, limit, locations):
    """Run an HTTPS HEAD from `limit` global probes. Returns dict or None."""
    locs = [{"magic": l.strip()} for l in locations] if locations else [{"magic": "world"}]
    payload = json.dumps({
        "type": "http", "target": host, "limit": limit, "locations": locs,
        "measurementOptions": {"protocol": "HTTPS", "port": 443,
                               "request": {"method": "HEAD", "path": "/"}},
    }).encode()
    headers = {"Content-Type": "application/json",
               "Accept": "application/json", "User-Agent": UA}
    # Optional Globalping API token (env GLOBALPING_TOKEN) raises the rate limit.
    _gp_token = os.environ.get("GLOBALPING_TOKEN", "").strip()
    if _gp_token:
        headers["Authorization"] = f"Bearer {_gp_token}"
    req = urllib.request.Request(GLOBALPING, data=payload, method="POST",
                                 headers=headers)
    try:
        with opener.open(req, timeout=timeout) as r:
            mid = json.loads(r.read())["id"]
    except urllib.error.HTTPError as e:
        return {"error": f"globalping HTTP {e.code} (rate limited?)"}
    except Exception as e:
        return {"error": f"globalping: {str(e)[:50]}"}

    poll = f"{GLOBALPING}/{mid}"
    deadline = time.monotonic() + max(timeout * 4, 20)
    res = None
    while time.monotonic() < deadline:
        try:
            res = json.loads(http_get(poll, opener, timeout))
        except Exception:
            break
        if res.get("status") == "finished":
            break
        time.sleep(1.0)
    if not res or not res.get("results"):
        return {"error": "globalping: no results"}

    probes = []
    for item in res["results"]:
        p = item.get("probe", {})
        rr = item.get("result", {})
        code = rr.get("statusCode")
        ok = rr.get("status") == "finished" and code is not None and code < 500
        probes.append({"country": p.get("country", "??"), "city": p.get("city", ""),
                       "net": p.get("network", ""), "code": code, "ok": ok})
    up = sum(1 for p in probes if p["ok"])
    return {"up": up, "total": len(probes), "probes": probes}


# --------------------------------------------------------------------------- #
# region / component granularity — "X of Y regions up" with a per-region list
# --------------------------------------------------------------------------- #
GCP_PRODUCTS = "https://status.cloud.google.com/products.json"


def load_chronic(out_dir, k=12, min_snaps=4):
    """Regions that were down in *every* one of the last `k` run snapshots (and we
    have at least `min_snaps`) are 'chronic' — persistently re-routed / under-
    maintenance components that shouldn't read as a live outage. Returns
    {provider_key: set(region_name)}. Built from prior snapshots, so it lags new
    outages by a few scans (a freshly-down region is NOT yet chronic)."""
    import glob
    try:
        files = sorted(glob.glob(os.path.join(out_dir, "runs", "*.json")))[-k:]
    except Exception:
        return {}
    if len(files) < min_snaps:
        return {}
    down, nsnaps = {}, 0
    for f in files:
        try:
            with open(f) as fh:
                snap = json.load(fh)
        except Exception:
            continue
        nsnaps += 1
        for r in snap.get("results", []):
            reg = r.get("regions") or {}
            if reg.get("error"):
                continue
            d = down.setdefault(r.get("key"), {})
            for it in reg.get("items", []):
                if not it.get("ok"):
                    nm = it.get("name", "")
                    d[nm] = d.get(nm, 0) + 1
    if nsnaps < min_snaps:
        return {}
    thr = max(2, (nsnaps + 1) // 2)   # down in at least ~half the recent scans
    return {key: {nm for nm, c in d.items() if c >= thr}
            for key, d in down.items() if any(c >= thr for c in d.values())}


def _region_result(kind, items, total, chronic):
    """Attach chronic flags and compute up/real_down. A region down in every
    recent scan (name in `chronic`) is treated as up — it's a persistently
    re-routed / under-maintenance component, not a live outage."""
    chronic = chronic or set()
    n_chronic = real_down = 0
    for it in items:
        it["chronic"] = (not it["ok"]) and (it["name"] in chronic)
        if it["chronic"]:
            n_chronic += 1
        elif not it["ok"]:
            real_down += 1
    return {"kind": kind, "up": total - real_down, "total": total,
            "real_down": real_down, "chronic": n_chronic, "items": items}


def check_regions(prov, opener, timeout, chronic=None):
    """Return {kind, up, total, real_down, chronic, items:[{name,status,ok,chronic}]} or None."""
    cfg = prov.get("regions")
    if not cfg:
        return None
    kind = cfg["kind"]
    try:
        if kind == "components":
            comps = json.loads(http_get(cfg["url"], opener, timeout)).get("components", [])
            items = []
            for c in comps:
                if c.get("group"):  # skip container/group headers, count leaves
                    continue
                st = c.get("status", "")
                # operational + planned maintenance count as up; outages do not.
                ok = st in ("operational", "under_maintenance")
                items.append({"name": c.get("name", ""), "status": st, "ok": ok})
            items.sort(key=lambda x: x["name"])
            return _region_result("components", items, len(items), chronic)

        if kind == "gcp":
            pdata = json.loads(http_get(GCP_PRODUCTS, opener, timeout))
            prods = pdata["products"] if isinstance(pdata, dict) else pdata
            inc = json.loads(http_get(prov["status"], opener, timeout))
            affected = {}
            for i in inc:
                if i.get("end"):
                    continue
                for ap in i.get("affected_products", []) or []:
                    affected[ap.get("id") or ap.get("title")] = ap.get("title")
            total = len(prods)
            items = [{"name": t or "?", "status": "incident", "ok": False} for t in affected.values()]
            return _region_result("products", items, total, chronic)

        if kind == "probe":
            pairs = [(r, cfg["tmpl"].format(r)) for r in cfg["list"]]
            items = []
            with cf.ThreadPoolExecutor(max_workers=12) as ex:
                futs = {ex.submit(http_probe, u, opener, timeout): n for n, u in pairs}
                for f in cf.as_completed(futs):
                    n = futs[f]
                    ok, _code, _ = f.result()
                    items.append({"name": n, "status": "up" if ok else "down", "ok": ok})
            items.sort(key=lambda x: x["name"])
            return _region_result("probe", items, len(items), chronic)
    except Exception as e:
        return {"kind": kind, "error": str(e)[:60], "up": 0, "total": 0, "items": []}
    return None


# --------------------------------------------------------------------------- #
# per-provider orchestration
# --------------------------------------------------------------------------- #
def fetch_incidents(prov, opener, timeout, limit=12):
    """Recent incidents from the provider's own feed, with update timeline +
    affected components. Statuspage exposes incidents.json; GCP's status feed is
    already a list of incidents; reach/AWS providers have no incident feed."""
    method = prov["method"]
    try:
        if method == "statuspage":
            url = (prov.get("status") or "").replace("status.json", "incidents.json")
            incs = json.loads(http_get(url, opener, timeout)).get("incidents", [])
            out = []
            for inc in incs[:limit]:
                ups = [{"at": u.get("created_at"), "status": u.get("status", ""),
                        "body": (u.get("body", "") or "")[:500]}
                       for u in (inc.get("incident_updates") or [])[:8]]
                out.append({
                    "id": str(inc.get("id") or ""),
                    "name": inc.get("name", ""),
                    "impact": inc.get("impact", "none"),
                    "status": inc.get("status", ""),
                    "started_at": inc.get("started_at") or inc.get("created_at"),
                    "resolved_at": inc.get("resolved_at"),
                    "components": [c.get("name", "") for c in (inc.get("components") or [])],
                    "updates": ups,
                })
            return out
        if method == "gcp":
            data = json.loads(http_get(prov["status"], opener, timeout))
            incs = data if isinstance(data, list) else []
            out = []
            for inc in incs[:limit]:
                ups = [{"at": u.get("when") or u.get("created"), "status": u.get("status", ""),
                        "body": (u.get("text", "") or "")[:500]}
                       for u in (inc.get("updates") or [])[:8]]
                out.append({
                    "id": str(inc.get("id") or inc.get("number") or ""),
                    "name": inc.get("external_desc") or "Service incident",
                    "impact": inc.get("severity", "minor"),
                    "status": "resolved" if inc.get("end") else "ongoing",
                    "started_at": inc.get("begin"),
                    "resolved_at": inc.get("end"),
                    "components": [ap.get("title", "") for ap in (inc.get("affected_products") or [])],
                    "updates": ups,
                })
            return out
    except Exception:
        return []
    return []


def check_provider(prov, opener, timeout, want_globe, globe_limit, globe_locs, chronic=None):
    r = {"key": prov["key"], "name": prov["name"], "page": prov["page"]}

    # 1. status feed
    s_state, s_detail, s_line = status_feed(prov, opener, timeout)
    r["status"] = {"state": s_state, "detail": s_detail, "line": s_line}

    # 2. http reachability across several endpoints (best-effort, concurrent)
    http_results = {}
    with cf.ThreadPoolExecutor(max_workers=len(prov["reach"])) as ex:
        for url, (ok, code, note) in zip(prov["reach"],
                                         ex.map(lambda u: http_probe(u, opener, timeout), prov["reach"])):
            http_results[url] = {"ok": ok, "code": code, "note": note}
    http_ok = any(v["ok"] for v in http_results.values())
    r["http"] = {"ok": http_ok, "endpoints": http_results}

    # 3. dns: system resolver (v4+v6) + DoH cross-check
    host = prov["dns"][0]
    v4, v6 = resolve_system(host, timeout)
    doh = {name: resolve_doh(host, name, url, opener, timeout) for name, url in DOH.items()}
    dns_ok = bool(v4 or v6) or any(doh.values())
    # do the resolvers disagree? (anycast / geo-routing perspective)
    seen = {tuple(a) for a in doh.values() if a}
    r["dns"] = {"ok": dns_ok, "host": host, "v4": sorted(v4), "v6": sorted(v6),
                "doh": doh, "perspectives": len(seen)}

    # 4. IPv6 reachability (separate path; often differs from IPv4)
    r["ipv6"] = {"ok": tcp_connect(host, 443, socket.AF_INET6, timeout), "host": host}

    # 5. globe (optional)
    r["globe"] = globalping(host, opener, timeout, globe_limit, globe_locs) if want_globe else None

    # 6. region / component granularity
    r["regions"] = check_regions(prov, opener, timeout, chronic)
    r["incidents"] = fetch_incidents(prov, opener, timeout)

    # ---- verdict -----------------------------------------------------------
    globe = r["globe"]
    globe_ratio = (globe["up"] / globe["total"]) if globe and globe.get("total") else None
    reg = r["regions"]
    reg_down = (reg["total"] - reg["up"]) if reg and not reg.get("error") and reg.get("total") else 0

    if prov["method"] == "reach":
        if http_ok:        final = "UP"
        elif dns_ok:       final = "DEGRADED"
        else:              final = "DOWN"
    elif s_state == "UP":
        if http_ok:        final = "UP"
        elif globe_ratio and globe_ratio >= 0.5:
            final = "UP"   # feed says ok + reachable globally -> it's your IP, not them
        else:              final = "DEGRADED"
    elif s_state == "DEGRADED":
        # A feed "minor"/"maintenance" fully explained by chronic re-routing /
        # maintenance (no live region outage) on a reachable edge is not a real
        # degradation — don't flag the provider forever.
        if http_ok and reg and not reg.get("error") and reg.get("chronic") and reg_down == 0:
            final = "UP"
        else:
            final = "DEGRADED"
    elif s_state == "DOWN":
        final = "DOWN"
    else:  # UNKNOWN feed -> trust live probes (+globe if present)
        if http_ok or (globe_ratio and globe_ratio >= 0.5):
            final = "UP"
        elif dns_ok:       final = "DEGRADED"
        else:              final = "DOWN"

    # A partial-region outage means at least DEGRADED even if the feed says fine.
    if reg_down > 0 and final == "UP":
        final = "DEGRADED"

    # If we can't reach it locally but the world can, annotate the split-brain.
    if not http_ok and globe_ratio and globe_ratio >= 0.5:
        r["note"] = "unreachable from this IP but reachable globally"

    # Headline detail: prefer the feed's own words; degrade gracefully when the
    # feed is silent so we never headline a raw parse error.
    n_ok = sum(1 for v in http_results.values() if v["ok"])
    n_ep = len(http_results)
    if prov["method"] == "reach":
        r["headline"] = f"reachable ({n_ok}/{n_ep} endpoints)" if http_ok else "unreachable"
    elif s_state in ("UNKNOWN", "n/a"):
        r["headline"] = "status feed unavailable — reachable" if http_ok else s_detail
    else:
        r["headline"] = s_detail

    # Fold region health into the headline (it's the most actionable summary).
    if reg and not reg.get("error") and reg.get("total"):
        rtxt = f"{reg['up']}/{reg['total']} regions up"
        if reg.get("chronic"):
            rtxt += f" · {reg['chronic']} re-routed"
        if reg_down > 0:
            r["headline"] = f"{reg_down} region(s) down — {rtxt}"
        elif reg.get("chronic") and final == "UP":
            r["headline"] = rtxt   # chronic re-routes excluded; surface them
        elif prov["method"] == "reach" or s_state in ("UNKNOWN", "n/a"):
            r["headline"] = rtxt

    r["state"] = final
    return r


# --------------------------------------------------------------------------- #
# result storage — one flat row per provider per run, append-only, so a history
# of many runs can be analysed in bulk (jq / pandas / sqlite / duckdb).
# --------------------------------------------------------------------------- #
# Shared schema, kept identical to the bash suite so both write the same files.
CSV_COLS = ["checked_at", "provider", "name", "state", "status_state",
            "status_detail", "http_ok", "http_codes", "dns_ok", "dns_v4",
            "dns_v6", "doh_views", "ipv6_ok", "globe_up", "globe_total",
            "regions_up", "regions_total", "vantage", "note"]


def flat_row(r, run_id, vantage):
    g = r.get("globe") or {}
    reg = r.get("regions") or {}
    has_reg = reg and not reg.get("error") and reg.get("total")
    eps = r["http"]["endpoints"]
    return {
        "checked_at": run_id,
        "provider": r["key"],
        "name": r["name"],
        "state": r["state"],
        "status_state": r["status"]["state"],
        "status_detail": r["status"]["detail"],
        "http_ok": int(r["http"]["ok"]),
        "http_codes": "|".join(str(v["code"]) for v in eps.values()),
        "dns_ok": int(r["dns"]["ok"]),
        "dns_v4": len(r["dns"]["v4"]),
        "dns_v6": len(r["dns"]["v6"]),
        "doh_views": r["dns"]["perspectives"],
        "ipv6_ok": int(r["ipv6"]["ok"]),
        "globe_up": g.get("up", ""),
        "globe_total": g.get("total", ""),
        "regions_up": reg["up"] if has_reg else "",
        "regions_total": reg["total"] if has_reg else "",
        "vantage": vantage,
        "note": r.get("note", ""),
    }


def store_results(results, outdir, run_id, vantage):
    runs_dir = os.path.join(outdir, "runs")
    os.makedirs(runs_dir, exist_ok=True)
    rows = [flat_row(r, run_id, vantage) for r in results]

    # 1. append-only JSONL — one record per provider per run
    with open(os.path.join(outdir, "history.jsonl"), "a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")

    # 2. append-only CSV — same fields, header written once
    csv_path = os.path.join(outdir, "history.csv")
    new = not os.path.exists(csv_path) or os.path.getsize(csv_path) == 0
    with open(csv_path, "a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLS)
        if new:
            w.writeheader()
        w.writerows(rows)

    # 3. full nested snapshot for this run (deep dives / reproducibility)
    snap = os.path.join(runs_dir, run_id.replace(":", "-") + ".json")
    with open(snap, "w", encoding="utf-8") as f:
        json.dump({"checked_at": run_id, "vantage": vantage, "results": results}, f, indent=2)
    return csv_path, snap


# --------------------------------------------------------------------------- #
# output
# --------------------------------------------------------------------------- #
def print_text(results, quiet):
    for r in results:
        glyph, color = STATE_FMT.get(r["state"], STATE_FMT["UNKNOWN"])
        state_col = color(C.bold(f"{r['state']:<8}"))
        head = f"{color(glyph)}  {r['name']:<22} {state_col} "
        head += C.dim(r.get("headline", r["status"]["detail"]))
        if r.get("note"):
            head += "  " + C.yellow(f"⚠ {r['note']}")
        print(head)
        if quiet:
            continue

        st = r["status"]
        mk = lambda ok: C.green("✓") if ok else C.red("✗")
        lines = []

        s_mark = "-" if st["state"] == "n/a" else mk(st["state"] not in ("UNKNOWN", "n/a"))
        lines.append(f"status  {s_mark}  {C.dim(st['line'])}")

        eps = "  ".join(f"{mk(v['ok'])}{C.dim(str(v['code']))}" for v in r["http"]["endpoints"].values())
        lines.append(f"http    {mk(r['http']['ok'])}  {C.dim('endpoints:')} {eps}")

        d = r["dns"]
        persp = f"{d['perspectives']} resolver view(s)" if d["perspectives"] else "no DoH answers"
        dns_detail = "{}: {} A / {} AAAA · {}".format(d["host"], len(d["v4"]), len(d["v6"]), persp)
        lines.append(f"dns     {mk(d['ok'])}  {C.dim(dns_detail)}")
        lines.append(f"ipv6    {mk(r['ipv6']['ok'])}  {C.dim('TCP/443 over IPv6')}")

        reg = r.get("regions")
        if reg is not None:
            if reg.get("error"):
                lines.append(f"regions -  {C.dim('error: ' + reg['error'])}")
            else:
                downs = [i["name"] for i in reg["items"] if not i["ok"]][:6]
                rdetail = f"{reg['up']}/{reg['total']} up ({reg['kind']})"
                if downs:
                    rdetail += " · down: " + ", ".join(downs)
                lines.append(f"regions {mk(reg['up'] == reg['total'])}  {C.dim(rdetail)}")

        g = r["globe"]
        if g is not None:
            if g.get("error"):
                lines.append(f"globe   -  {C.dim(g['error'])}")
            else:
                where = ", ".join(sorted({p["country"] for p in g["probes"]}))[:60]
                ok = bool(g["total"]) and g["up"] >= g["total"] / 2
                lines.append(f"globe   {mk(ok)}  {C.dim(f'{g['up']}/{g['total']} probes reachable · {where}')}")

        for i, ln in enumerate(lines):
            conn = "└" if i == len(lines) - 1 else "├"
            print(f"     {C.dim(conn)} {ln}")
    # summary
    n = {"UP": 0, "DEGRADED": 0, "DOWN": 0, "UNKNOWN": 0}
    for r in results:
        n[r["state"]] = n.get(r["state"], 0) + 1
    parts = [C.green(f"{n['UP']} up")]
    if n["DEGRADED"]:
        parts.append(C.yellow(f"{n['DEGRADED']} degraded"))
    if n["DOWN"] + n["UNKNOWN"]:
        parts.append(C.red(f"{n['DOWN'] + n['UNKNOWN']} down"))
    print("\n" + C.bold("summary") + "  " + " · ".join(parts) + f" · {len(results)} total")


def main():
    ap = argparse.ArgumentParser(description="Multi-method cloud provider status checker.")
    ap.add_argument("providers", nargs="*", help="provider keys to check (default: all)")
    ap.add_argument("-t", "--timeout", type=float, default=8.0, help="per-probe timeout seconds")
    ap.add_argument("-q", "--quiet", action="store_true", help="one line per provider")
    ap.add_argument("--json", action="store_true", help="machine-readable JSON output")
    ap.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    ap.add_argument("--proxy", help="route probes via proxy (http://… or socks5h://host:port)")
    ap.add_argument("--globe", nargs="?", type=int, const=5, default=0, metavar="N",
                    help="also test from N worldwide probes via Globalping (default 5)")
    ap.add_argument("--locations", default="",
                    help="comma list of Globalping locations, e.g. 'US,DE,JP,AU,BR'")
    ap.add_argument("--out", default="results", metavar="DIR",
                    help="directory for history.jsonl / history.csv / runs/ (default: results)")
    ap.add_argument("--no-store", action="store_true", help="do not write result files")
    ap.add_argument("--list", action="store_true", help="list provider keys and exit")
    args = ap.parse_args()

    if args.no_color:
        C.enabled = False
    if args.list:
        for p in PROVIDERS:
            print(f"  {p['key']:<14} {p['name']}")
        return 0

    # SOCKS proxy: patch socket globally so DNS + TCP + HTTP all egress via it.
    if args.proxy and args.proxy.split("://", 1)[0].startswith("socks"):
        try:
            import socks  # PySocks
            scheme, rest = args.proxy.split("://", 1)
            host, port = rest.split(":")
            ptype = socks.SOCKS5 if "5" in scheme else socks.SOCKS4
            rdns = scheme.endswith("h")
            socks.set_default_proxy(ptype, host, int(port), rdns=rdns)
            socket.socket = socks.socksocket
        except ImportError:
            print("error: socks proxy needs PySocks  ->  pip install pysocks", file=sys.stderr)
            return 2

    selected = PROVIDERS
    if args.providers:
        keys = {p["key"] for p in PROVIDERS}
        bad = [p for p in args.providers if p not in keys]
        if bad:
            print(f"unknown provider(s): {', '.join(bad)}", file=sys.stderr)
            print("known: " + ", ".join(sorted(keys)), file=sys.stderr)
            return 2
        selected = [p for p in PROVIDERS if p["key"] in args.providers]

    opener = build_opener(args.proxy)
    locs = [x for x in args.locations.split(",") if x.strip()]

    if not args.json:
        via = f" · via {args.proxy}" if args.proxy else ""
        globe = f" · globe x{args.globe}" if args.globe else ""
        ts = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
        print(C.bold("cloud provider status") + "  " + C.dim(f"(timeout {args.timeout}s · {ts}{via}{globe})") + "\n")

    # providers run concurrently; ordering restored afterwards
    chronic_map = load_chronic(args.out)
    with cf.ThreadPoolExecutor(max_workers=min(len(selected), 16)) as ex:
        futs = {ex.submit(check_provider, p, opener, args.timeout,
                          bool(args.globe), args.globe or 5, locs,
                          chronic_map.get(p["key"], set())): p["key"] for p in selected}
        done = {futs[f]: f.result() for f in cf.as_completed(futs)}
    results = [done[p["key"]] for p in selected]

    run_id = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    vantage = args.proxy if args.proxy else "local"

    if args.json:
        print(json.dumps({"checked_at": run_id, "vantage": vantage, "results": results}, indent=2))
    else:
        print_text(results, args.quiet)

    if not args.no_store:
        csv_path, snap = store_results(results, args.out, run_id, vantage)
        if not args.json:
            print(C.dim(f"stored {len(results)} rows -> {csv_path} (+ history.jsonl, {snap})"))

    bad = any(r["state"] in ("DEGRADED", "DOWN", "UNKNOWN") for r in results)
    return 1 if bad else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
