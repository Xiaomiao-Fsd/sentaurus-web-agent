#!/usr/bin/env bash
set -uo pipefail
ROOT="$HOME/.sentaurus-web-agent/vm-agent"
WORKER="$ROOT/agent_worker.py"
PIDFILE="$ROOT/agent_worker.pid"
LOG="$ROOT/agent_worker.log"
AUTOSTART_LOG="$ROOT/autostart.log"
STOPFILE="$ROOT/stop"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python}"
WORKER_COUNT="${WORKER_COUNT:-2}"
mkdir -p "$ROOT" "$ROOT/queue" "$ROOT/processed" "$ROOT/processing" "$ROOT/locks" "$ROOT/manuals"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf "%s %s\n" "$(ts)" "$*" >> "$AUTOSTART_LOG"; }
load_runtime_env() {
  set +u
  [ -r /etc/profile ] && . /etc/profile >/dev/null 2>&1 || true
  [ -r "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" >/dev/null 2>&1 || true
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true
  set -u
  for d in /opt/synopsys/sentaurus/T-2022.03/bin /opt/synopsys/SCL2021.12/linux64/bin; do
    [ -d "$d" ] || continue
    case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
  done
  export PATH
}
pid_is_worker() { [ -n "${1:-}" ] && ps -p "$1" -o args= 2>/dev/null | grep -F "$WORKER" >/dev/null 2>&1; }
find_worker_pids() { pgrep -f "$WORKER" 2>/dev/null | while read -r pid; do pid_is_worker "$pid" && echo "$pid"; done | sort -n | uniq; }
write_pidfile() { find_worker_pids > "$PIDFILE" 2>/dev/null || true; }
start_worker() {
  [ -f "$WORKER" ] || { echo "worker script missing: $WORKER" >&2; return 1; }
  rm -f "$STOPFILE"
  load_runtime_env
  current=$(find_worker_pids | wc -l | tr -d ' ')
  while [ "$current" -lt "$WORKER_COUNT" ]; do
    nohup "$PYTHON_BIN" "$WORKER" >> "$LOG" 2>&1 &
    pid=$!
    sleep 1
    if pid_is_worker "$pid"; then log "started pid=$pid"; current=$((current+1)); else echo "failed to start worker" >&2; return 1; fi
  done
  write_pidfile
  first=$(head -n 1 "$PIDFILE" 2>/dev/null || true)
  echo "sentaurus-vm-agent started pid=$first count=$current"
}
status_worker() {
  write_pidfile
  count=$(wc -l < "$PIDFILE" 2>/dev/null | tr -d ' ' || echo 0)
  first=$(head -n 1 "$PIDFILE" 2>/dev/null || true)
  pids=$(tr '\n' ' ' < "$PIDFILE" 2>/dev/null | sed 's/[[:space:]]*$//')
  [ -n "$first" ] && [ "$count" -gt 0 ] && { echo "running pid=$first count=$count pids=$pids"; return 0; }
  echo stopped; return 3
}
stop_worker() {
  touch "$STOPFILE"
  pids=$(find_worker_pids | tr '\n' ' ')
  [ -z "$pids" ] && { echo "not running"; : > "$PIDFILE"; return 0; }
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  sleep 2
  for pid in $pids; do pid_is_worker "$pid" && kill -KILL "$pid" 2>/dev/null || true; done
  : > "$PIDFILE"
  echo "killed pids=$pids"
}
case "${1:-start}" in
  start) start_worker ;;
  status) status_worker ;;
  stop) stop_worker ;;
  restart) stop_worker; rm -f "$STOPFILE"; start_worker ;;
  *) echo "Usage: $0 {start|status|stop|restart}" >&2; exit 2 ;;
esac
