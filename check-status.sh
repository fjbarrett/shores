#!/usr/bin/env bash
# check-status.sh — multi-method up/down check for the major cloud providers.
#
# For each provider it runs up to three independent methods and combines them:
#   1. the provider's official status feed (Statuspage / GCP / AWS JSON)
#   2. an HTTPS reachability probe against a real API/edge endpoint
#   3. a DNS resolution check
#
# A provider is UP only when the live probes agree with the status feed; if the
# feed is unreachable the verdict falls back to the reachability + DNS probes.
#
# Usage:
#   ./check-status.sh                 # check every provider
#   ./check-status.sh aws gcp vercel  # check a subset
#   ./check-status.sh -q              # quiet: one line per provider
#   ./check-status.sh -t 15           # 15s per-probe timeout
#   ./check-status.sh --list          # list provider keys
#
# Exit code: 0 = all UP, 1 = something DEGRADED/DOWN, 2 = bad usage.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/providers.sh
. "$LIB_DIR/providers.sh"

QUIET=0
OUT="results"
STORE=1
VANTAGE="local"
WANTED=()

usage() {
  sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

list_providers() {
  printf '%sAvailable providers:%s\n' "$C_BOLD" "$C_RESET"
  provider_table | while IFS='|' read -r key name _; do
    printf '  %-14s %s\n' "$key" "$name"
  done
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)      usage; exit 0 ;;
    -l|--list)      list_providers; exit 0 ;;
    -q|--quiet)     QUIET=1 ;;
    --no-color)     CLOUDCHECK_COLOR=never; . "$LIB_DIR/common.sh" ;;
    --out)          shift; OUT="${1:-results}" ;;
    --no-store)     STORE=0 ;;
    -t|--timeout)   shift; CLOUDCHECK_TIMEOUT="${1:-8}" ;;
    -t*)            CLOUDCHECK_TIMEOUT="${1#-t}" ;;
    -*)             printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *)              WANTED+=("$1") ;;
  esac
  shift
done

# Validate any requested keys up front.
if [ "${#WANTED[@]}" -gt 0 ]; then
  for w in "${WANTED[@]}"; do
    if ! provider_table | grep -q "^$w|"; then
      printf '%sunknown provider: %s%s\n' "$C_RED" "$w" "$C_RESET" >&2
      list_providers >&2
      exit 2
    fi
  done
fi

wanted() {
  [ "${#WANTED[@]}" -eq 0 ] && return 0
  local k; for k in "${WANTED[@]}"; do [ "$k" = "$1" ] && return 0; done
  return 1
}

# Storage setup: append-only history shared with cloudcheck.py.
RUN_ID="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$STORE" = 1 ]; then
  mkdir -p "$OUT/runs"
  CSV_FILE="$OUT/history.csv"
  JSONL_FILE="$OUT/history.jsonl"
  [ -s "$CSV_FILE" ] || printf '%s\n' "$CSV_HEADER" > "$CSV_FILE"
fi

printf '%scloud provider status%s  %s(timeout %ss, %s)%s\n\n' \
  "$C_BOLD" "$C_RESET" "$C_DIM" "$CLOUDCHECK_TIMEOUT" "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$C_RESET"

# Iterate the table via a here-doc redirect (NOT a pipe) so the counters that
# run_check increments survive in this shell.
while IFS='|' read -r key name method surl rurl dhost page; do
  [ -z "$key" ] && continue
  wanted "$key" || continue
  run_check "$key" "$name" "$method" "$surl" "$rurl" "$dhost" "$page"
done <<EOF
$(provider_table)
EOF

# --- summary -------------------------------------------------------------------
printf '\n%ssummary%s  ' "$C_BOLD" "$C_RESET"
printf '%s%d up%s' "$C_GREEN" "$N_UP" "$C_RESET"
[ "$N_DEGRADED" -gt 0 ] && printf ' · %s%d degraded%s' "$C_YELLOW" "$N_DEGRADED" "$C_RESET"
[ "$N_DOWN" -gt 0 ]     && printf ' · %s%d down%s'     "$C_RED"    "$N_DOWN"    "$C_RESET"
printf ' · %d total\n' "$N_TOTAL"
[ "$STORE" = 1 ] && printf '%sstored %d rows -> %s (+ history.jsonl)%s\n' "$C_DIM" "$N_TOTAL" "$CSV_FILE" "$C_RESET"

[ "$N_DEGRADED" -eq 0 ] && [ "$N_DOWN" -eq 0 ] && exit 0
exit 1
