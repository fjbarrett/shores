#!/usr/bin/env bash
# lib/providers.sh — provider table, status-API parsers, and the per-provider
# multi-method check. Sourced by check-status.sh.

# provider_table — one provider per line, pipe-separated:
#   key | display name | method | status_url | reach_url | dns_host | page_url
#
# method:
#   statuspage  Atlassian Statuspage v2 JSON  (.status.indicator)
#   gcp         status.cloud.google.com incidents.json
#   aws         status.aws.amazon.com data.json
#   reach       no machine-readable status feed -> verdict from reachability+DNS
provider_table() {
  cat <<'EOF'
aws|Amazon Web Services|aws|https://status.aws.amazon.com/data.json|https://aws.amazon.com|aws.amazon.com|https://health.aws.amazon.com/health/status
gcp|Google Cloud Platform|gcp|https://status.cloud.google.com/incidents.json|https://cloud.google.com|cloud.google.com|https://status.cloud.google.com
azure|Microsoft Azure|reach|-|https://management.azure.com|management.azure.com|https://status.azure.com
cloudflare|Cloudflare|statuspage|https://www.cloudflarestatus.com/api/v2/status.json|https://www.cloudflare.com|www.cloudflare.com|https://www.cloudflarestatus.com
digitalocean|DigitalOcean|statuspage|https://status.digitalocean.com/api/v2/status.json|https://api.digitalocean.com|api.digitalocean.com|https://status.digitalocean.com
oracle|Oracle Cloud (OCI)|statuspage|https://ocistatus.oraclecloud.com/api/v2/status.json|https://cloud.oracle.com|cloud.oracle.com|https://ocistatus.oraclecloud.com
linode|Akamai Linode|statuspage|https://status.linode.com/api/v2/status.json|https://api.linode.com|api.linode.com|https://status.linode.com
vercel|Vercel|statuspage|https://www.vercel-status.com/api/v2/status.json|https://vercel.com|vercel.com|https://www.vercel-status.com
ibm|IBM Cloud|reach|-|https://cloud.ibm.com|cloud.ibm.com|https://cloud.ibm.com/status
alibaba|Alibaba Cloud|reach|-|https://www.alibabacloud.com|www.alibabacloud.com|https://status.alibabacloud.com
tencent|Tencent Cloud|reach|-|https://intl.cloud.tencent.com|intl.cloud.tencent.com|https://status.cloud.tencent.com
ovh|OVHcloud|reach|-|https://www.ovhcloud.com|www.ovhcloud.com|https://status.ovhcloud.com
meta|Meta Platforms|reach|-|https://www.facebook.com|facebook.com|https://metastatus.com
bytedance|ByteDance (Volcano Engine)|reach|-|https://www.volcengine.com|www.volcengine.com|https://www.volcengine.com
EOF
}

# --- status-feed parsers -------------------------------------------------------
# Each reads JSON on stdin and prints a tiny pipe-delimited summary. They prefer
# jq, fall back to python3, then to a crude grep so the suite still runs bare.

# parse_statuspage -> "<indicator>|<description>"
parse_statuspage() {
  if have jq; then
    jq -r '"\(.status.indicator // "")|\(.status.description // "")"' 2>/dev/null
  elif have python3; then
    python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print("|"); sys.exit()
s=d.get("status",{}) or {}
print((s.get("indicator") or "")+"|"+(s.get("description") or ""))' 2>/dev/null
  else
    local body ind desc; body=$(cat)
    ind=$(printf '%s' "$body"  | grep -o '"indicator"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    desc=$(printf '%s' "$body" | grep -o '"description"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)"$/\1/')
    printf '%s|%s' "$ind" "$desc"
  fi
}

# parse_gcp -> "<ongoing_incident_count>|<max_severity>" (severity: none|low|medium|high)
parse_gcp() {
  if have python3; then
    python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print("err|none"); sys.exit()
rank={"low":1,"medium":2,"high":3}; sev="none"; r=0
ongoing=[i for i in d if not i.get("end")]
for i in ongoing:
    s=(i.get("severity") or "").lower()
    if rank.get(s,0)>r: r=rank[s]; sev=s
print(f"{len(ongoing)}|{sev}")' 2>/dev/null
  elif have jq; then
    jq -r '[.[]|select(.end==null)] as $o
           | ($o|map(.severity)|map({"low":1,"medium":2,"high":3}[.]//0)|max//0) as $r
           | "\($o|length)|\(if $r>=3 then "high" elif $r==2 then "medium" elif $r==1 then "low" else "none" end)"' 2>/dev/null
  else
    echo "skip|none"
  fi
}

# parse_aws -> "<current_open_event_count>"
parse_aws() {
  if have python3; then
    python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print("err"); sys.exit()
print(len(d.get("current",[])))' 2>/dev/null
  elif have jq; then
    jq -r '.current | length' 2>/dev/null
  else
    echo skip
  fi
}

# Counters / state shared with check-status.sh.
N_UP=0; N_DEGRADED=0; N_DOWN=0; N_TOTAL=0

# CSV header — identical schema to cloudcheck.py so both write the same files.
CSV_HEADER='checked_at,provider,name,state,status_state,status_detail,http_ok,http_codes,dns_ok,dns_v4,dns_v6,doh_views,ipv6_ok,globe_up,globe_total,regions_up,regions_total,vantage,note'

_json_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
_csv_esc()  { printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g' | tr '\n' ' ')"; }

# store_row provider name state status_state status_detail http_ok http_codes dns_ok
# Appends one flat record to history.csv and history.jsonl when STORE=1.
# The bash suite has no DoH/IPv6/globe columns, so those are left empty/null.
store_row() {
  [ "${STORE:-0}" = 1 ] || return 0
  local prov="$1" name="$2" state="$3" sstate="$4" sdetail="$5" hok="$6" codes="$7" dok="$8"
  # 19 columns; the bash suite has no DoH/IPv6/globe/region data, so those are empty.
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$RUN_ID" "$prov" "$(_csv_esc "$name")" "$state" "$sstate" \
    "$(_csv_esc "$sdetail")" "$hok" "$codes" "$dok" "" "" "" "" "" "" "" "" \
    "$(_csv_esc "${VANTAGE:-local}")" "$(_csv_esc '')" >> "$CSV_FILE"
  printf '{"checked_at":"%s","provider":"%s","name":"%s","state":"%s","status_state":"%s","status_detail":"%s","http_ok":%s,"http_codes":"%s","dns_ok":%s,"dns_v4":null,"dns_v6":null,"doh_views":null,"ipv6_ok":null,"globe_up":null,"globe_total":null,"regions_up":null,"regions_total":null,"vantage":"%s","note":""}\n' \
    "$RUN_ID" "$prov" "$(_json_esc "$name")" "$state" "$sstate" \
    "$(_json_esc "$sdetail")" "$hok" "$codes" "$dok" "${VANTAGE:-local}" >> "$JSONL_FILE"
}

# run_check key name method status_url reach_url dns_host page_url
# Performs every method, prints a result block, and updates the counters.
run_check() {
  local key="$1" name="$2" method="$3" surl="$4" rurl="$5" dhost="$6" page="$7"

  # ---- method 1: authoritative status feed --------------------------------
  local s_state='n/a' s_detail='' s_line=''
  case "$method" in
    statuspage)
      local body parsed ind desc
      body=$(http_body "$surl")
      if [ -n "$body" ]; then
        parsed=$(printf '%s' "$body" | parse_statuspage)
        ind="${parsed%%|*}"; desc="${parsed#*|}"
        case "$ind" in
          none|operational|"") s_state=UP;       s_detail="${desc:-All Systems Operational}" ;;
          minor)               s_state=DEGRADED;  s_detail="${desc:-Minor service issue}" ;;
          major|critical)      s_state=DOWN;      s_detail="${desc:-Service outage}" ;;
          maintenance)         s_state=DEGRADED;  s_detail="${desc:-Maintenance in progress}" ;;
          *)                   s_state=UNKNOWN;   s_detail="${desc:-unrecognised indicator}" ;;
        esac
        s_line="statuspage api: ${ind:-?} — $s_detail"
      else
        s_state=UNKNOWN; s_detail='status feed unreachable'; s_line="statuspage api: no response"
      fi
      ;;
    gcp)
      local body parsed cnt sev
      body=$(http_body "$surl")
      if [ -n "$body" ]; then
        parsed=$(printf '%s' "$body" | parse_gcp); cnt="${parsed%%|*}"; sev="${parsed#*|}"
        if [ "$cnt" = skip ] || [ "$cnt" = err ]; then
          s_state=UNKNOWN; s_detail='could not parse incidents.json'; s_line="incidents.json: parse failed"
        elif [ "${cnt:-0}" -eq 0 ] 2>/dev/null; then
          s_state=UP; s_detail='No active incidents'; s_line="incidents.json: 0 open incidents"
        else
          case "$sev" in high) s_state=DOWN ;; *) s_state=DEGRADED ;; esac
          s_detail="$cnt active incident(s), max severity: $sev"; s_line="incidents.json: $s_detail"
        fi
      else
        s_state=UNKNOWN; s_detail='status feed unreachable'; s_line="incidents.json: no response"
      fi
      ;;
    aws)
      local body cnt
      body=$(http_body "$surl")
      if [ -n "$body" ]; then
        cnt=$(printf '%s' "$body" | parse_aws)
        if [ "$cnt" = skip ] || [ "$cnt" = err ] || [ -z "$cnt" ]; then
          s_state=UNKNOWN; s_detail='could not parse status feed'; s_line="data.json: parse failed"
        elif [ "$cnt" -eq 0 ] 2>/dev/null; then
          s_state=UP; s_detail='No open events'; s_line="data.json: 0 open events"
        else
          s_state=DEGRADED; s_detail="$cnt open service event(s)"; s_line="data.json: $s_detail"
        fi
      else
        s_state=UNKNOWN; s_detail='status feed unreachable'; s_line="data.json: no response (feed may be retired)"
      fi
      ;;
    reach)
      s_state='n/a'; s_detail='no machine-readable feed'; s_line="no public status api — see $page"
      ;;
  esac

  # ---- method 2: HTTPS edge reachability ----------------------------------
  local r_code r_ok=0
  r_code=$(http_probe "$rurl") && r_ok=1
  [ -z "$r_code" ] && r_code='---'

  # ---- method 3: DNS resolution -------------------------------------------
  local d_ok=0; dns_resolve "$dhost" && d_ok=1

  # ---- verdict ------------------------------------------------------------
  local final
  if [ "$method" = reach ]; then
    if   [ "$r_ok" = 1 ]; then final=UP
    elif [ "$d_ok" = 1 ]; then final=DEGRADED
    else final=DOWN; fi
  else
    case "$s_state" in
      UP)       [ "$r_ok" = 1 ] && final=UP || final=DEGRADED ;;
      DEGRADED) final=DEGRADED ;;
      DOWN)     final=DOWN ;;
      *)  # status feed unknown -> trust the live probes
          if   [ "$r_ok" = 1 ]; then final=UP
          elif [ "$d_ok" = 1 ]; then final=DEGRADED
          else final=DOWN; fi ;;
    esac
  fi

  # ---- tally --------------------------------------------------------------
  N_TOTAL=$((N_TOTAL + 1))
  case "$final" in
    UP)       N_UP=$((N_UP + 1)) ;;
    DEGRADED) N_DEGRADED=$((N_DEGRADED + 1)) ;;
    *)        N_DOWN=$((N_DOWN + 1)) ;;
  esac

  # ---- print --------------------------------------------------------------
  local col; col=$(state_color "$final")
  printf '%s%s%s  %-22s %s%-8s%s %s%s\n' \
    "$col" "$(state_glyph "$final")" "$C_RESET" "$name" \
    "$col$C_BOLD" "$final" "$C_RESET" "$C_DIM" "${s_detail}${C_RESET}"

  if [ "${QUIET:-0}" != 1 ]; then
    if [ "$method" != reach ]; then
      printf '     %s├%s status  %s  %s%s%s\n' "$C_DIM" "$C_RESET" "$(mark $([ "$s_state" != UNKNOWN ] && [ "$s_state" != 'n/a' ] && echo 1 || echo 0))" "$C_DIM" "$s_line" "$C_RESET"
    else
      printf '     %s├%s status  %s  %s%s%s\n' "$C_DIM" "$C_RESET" "-" "$C_DIM" "$s_line" "$C_RESET"
    fi
    printf '     %s├%s http    %s  %s%s (%s)%s\n' "$C_DIM" "$C_RESET" "$(mark "$r_ok")" "$C_DIM" "$r_code" "$rurl" "$C_RESET"
    printf '     %s└%s dns     %s  %s%s%s\n'      "$C_DIM" "$C_RESET" "$(mark "$d_ok")" "$C_DIM" "$dhost" "$C_RESET"
  fi

  store_row "$key" "$name" "$final" "$s_state" "$s_detail" "$r_ok" "$r_code" "$d_ok"
}
