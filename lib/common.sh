#!/usr/bin/env bash
# lib/common.sh — low-level network probes and output helpers shared by the suite.
# Sourced by check-status.sh; not meant to be run directly.

# Per-probe network timeout in seconds. Override: CLOUDCHECK_TIMEOUT=15 ./check-status.sh
: "${CLOUDCHECK_TIMEOUT:=8}"

# --- colour / tty handling -----------------------------------------------------
# Honour NO_COLOR (https://no-color.org) and disable colour when not a terminal.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${CLOUDCHECK_COLOR:-auto}" != "never" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

have() { command -v "$1" >/dev/null 2>&1; }

# http_probe <url>
#   Prints the HTTP status code reached (or 000), returns 0 only if a real
#   HTTP response came back. Any code — including 401/403/404 — counts as
#   "the provider's edge answered us", which is what reachability means.
http_probe() {
  local url="$1" code rc
  code=$(curl -s -o /dev/null -L --max-time "$CLOUDCHECK_TIMEOUT" \
    -A 'cloudcheck/1.0 (+status probe)' -w '%{http_code}' "$url" 2>/dev/null)
  rc=$?
  printf '%s' "$code"
  if [ "$rc" -eq 0 ] && [ -n "$code" ] && [ "$code" != "000" ]; then
    return 0
  fi
  return 1
}

# http_body <url> — print response body to stdout (empty on failure).
http_body() {
  curl -s -L --max-time "$CLOUDCHECK_TIMEOUT" -A 'cloudcheck/1.0 (+status probe)' "$1" 2>/dev/null
}

# dns_resolve <host> — return 0 if the hostname resolves to any address.
# Tries the first available resolver tool so it works on a bare macOS or Linux box.
dns_resolve() {
  local host="$1"
  if have dig; then
    [ -n "$(dig +short +time=3 +tries=1 "$host" A    2>/dev/null)" ] && return 0
    [ -n "$(dig +short +time=3 +tries=1 "$host" AAAA 2>/dev/null)" ] && return 0
    return 1
  elif have host; then
    host -W 3 "$host" >/dev/null 2>&1
  elif have getent; then
    getent hosts "$host" >/dev/null 2>&1
  elif have python3; then
    python3 - "$host" <<'PY' 2>/dev/null
import socket, sys
try:
    socket.getaddrinfo(sys.argv[1], 443)
except Exception:
    sys.exit(1)
PY
  elif have nslookup; then
    nslookup "$host" >/dev/null 2>&1
  else
    return 2   # no resolver available
  fi
}

# tcp_check <host> <port> — return 0 if a TCP handshake completes.
tcp_check() {
  local host="$1" port="$2"
  if have nc; then
    nc -z -w "$CLOUDCHECK_TIMEOUT" "$host" "$port" >/dev/null 2>&1
  else
    # bash /dev/tcp fallback (no hard timeout, but 443 usually answers fast)
    (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1 && exec 3>&- 3<&-
  fi
}

# state_color / state_glyph — presentation for UP / DEGRADED / DOWN / UNKNOWN.
state_color() {
  case "$1" in
    UP)       printf '%s' "$C_GREEN" ;;
    DEGRADED) printf '%s' "$C_YELLOW" ;;
    DOWN)     printf '%s' "$C_RED" ;;
    *)        printf '%s' "$C_DIM" ;;
  esac
}
state_glyph() {
  case "$1" in
    UP)       printf '%s' '●' ;;
    DEGRADED) printf '%s' '◐' ;;
    DOWN)     printf '%s' '○' ;;
    *)        printf '%s' '?' ;;
  esac
}
mark() { [ "$1" = 1 ] && printf '%s✓%s' "$C_GREEN" "$C_RESET" || printf '%s✗%s' "$C_RED" "$C_RESET"; }
