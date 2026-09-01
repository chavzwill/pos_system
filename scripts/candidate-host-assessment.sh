#!/usr/bin/env bash
set -euo pipefail

failures=0
warnings=0
notes=0

pass(){ printf 'PASS: %s\n' "$*"; }
warn(){ printf 'WARN: %s\n' "$*"; warnings=$((warnings+1)); }
fail(){ printf 'FAIL: %s\n' "$*" >&2; failures=$((failures+1)); }
note(){ printf 'INFO: %s\n' "$*"; notes=$((notes+1)); }

printf 'Total Tools POS candidate-host assessment\n'
printf '========================================\n'

os="$(uname -s 2>/dev/null || true)"
if [ "$os" = "Linux" ]; then pass 'Linux host'; else fail "unsupported OS for certified production profile: ${os:-unknown}"; fi

cpu="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0')"
if [ "$cpu" -ge 2 ] 2>/dev/null; then pass "$cpu logical CPU(s)"; else fail "fewer than 2 logical CPUs detected ($cpu)"; fi

mem_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
if [ -n "$mem_kb" ]; then
  mem_mb=$((mem_kb/1024))
  if [ "$mem_mb" -ge 3500 ]; then pass "memory ${mem_mb} MB"; elif [ "$mem_mb" -ge 2500 ]; then warn "memory ${mem_mb} MB is below the certified 4 GB target"; else fail "memory ${mem_mb} MB is too low for the recommended production profile"; fi
else
  fail 'unable to determine system memory'
fi

free_kb="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$free_kb" ]; then
  free_gb=$((free_kb/1024/1024))
  if [ "$free_gb" -ge 40 ]; then pass "${free_gb} GB free storage"; elif [ "$free_gb" -ge 20 ]; then warn "${free_gb} GB free storage meets minimum but leaves limited upload growth headroom"; else fail "only ${free_gb} GB free storage detected; at least 20 GB free is required"; fi
else
  fail 'unable to determine free disk space'
fi

if command -v docker >/dev/null 2>&1; then
  pass 'Docker installed'
  if docker info >/dev/null 2>&1; then pass 'Docker daemon reachable'; else warn 'Docker installed but current operator cannot reach daemon'; fi
else
  warn 'Docker is not installed yet; host may still be usable after installation'
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then pass 'Docker Compose plugin available'; else warn 'Docker Compose plugin is not currently available'; fi

if command -v ip >/dev/null 2>&1; then
  default_iface="$(ip route show default 2>/dev/null | awk 'NR==1 {print $5}')"
  if [ -n "$default_iface" ]; then
    if [ -d "/sys/class/net/$default_iface/wireless" ]; then warn "default network interface $default_iface appears to be Wi-Fi; wired networking is preferred for the POS host"; else pass "default network interface $default_iface appears wired/non-wireless"; fi
  else
    warn 'could not determine default network interface'
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-system-running >/dev/null 2>&1 || systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; then pass 'systemd host state is usable'; else warn 'systemd does not report a normal running/degraded state'; fi
fi

if [ -r /proc/uptime ]; then
  uptime_seconds="$(awk '{print int($1)}' /proc/uptime)"
  uptime_days=$((uptime_seconds/86400))
  note "current host uptime: ${uptime_days} day(s)"
fi

if command -v curl >/dev/null 2>&1; then
  if curl --silent --show-error --fail --max-time 8 https://github.com/ >/dev/null 2>&1; then pass 'outbound HTTPS connectivity works'; else warn 'outbound HTTPS connectivity test failed'; fi
else
  warn 'curl is missing; certified readiness tooling requires it'
fi

if command -v hostname >/dev/null 2>&1; then note "hostname: $(hostname 2>/dev/null || true)"; fi

printf '\nAssessment summary: %d failure(s), %d warning(s), %d informational note(s).\n' "$failures" "$warnings" "$notes"

if [ "$failures" -gt 0 ]; then
  printf 'DECISION: FAIL — do not use this machine as the production POS host in its current state.\n'
  exit 2
elif [ "$warnings" -gt 0 ]; then
  printf 'DECISION: CONDITIONAL — candidate may be usable after the warnings are resolved and RC7 readiness passes.\n'
  exit 0
else
  printf 'DECISION: PASS — candidate meets the basic host profile; run RC7 production-host-readiness.sh next.\n'
  exit 0
fi
