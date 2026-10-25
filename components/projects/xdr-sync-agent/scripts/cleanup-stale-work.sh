#!/bin/bash
# Clean up stale per-job work directories left behind by failed or
# interrupted xdr-sync-agent runs.
#
# Safety rules (all must hold before a directory is deleted):
#   1. Only immediate children of <state_dir>/work are considered.
#   2. Only directories older than MAX_AGE_DAYS (default 7) are candidates.
#   3. The job_id currently recorded in status.json is never removed.
#   4. A directory with open file handles (an active job) is never removed.
#
# Env overrides:
#   MAX_AGE_DAYS  e.g. 7   (default)
#   DRY_RUN=1     list what would be deleted without deleting

set -euo pipefail

: "${HOME:?HOME is not set}"

MAX_AGE_DAYS="${MAX_AGE_DAYS:-7}"
DRY_RUN="${DRY_RUN:-0}"

LOG_DIR="$HOME/Library/Logs/xdr-sync-agent-cleanup"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/cleanup.log"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$*" >> "$LOG_FILE"
}

STATE_DIRS=(
  "$HOME/Library/Application Support/xdr-sync-agent"
  "$HOME/Library/Application Support/xdr-sync-agent-profit-facts"
)

deleted=0
dry_deleted=0
skipped_active=0
skipped_open=0

for state_dir in "${STATE_DIRS[@]}"; do
  work="$state_dir/work"
  [ -d "$work" ] || continue

  current_job_id=""
  status_file="$state_dir/status.json"
  if [ -f "$status_file" ]; then
    current_job_id="$(sed -n 's/.*"job_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$status_file" | head -n 1)"
  fi

  while IFS= read -r -d '' dir; do
    name="$(basename "$dir")"

    # Rule 3: never touch the current job
    if [ -n "$current_job_id" ] && [ "$name" = "$current_job_id" ]; then
      skipped_active=$((skipped_active + 1))
      log "skip (active job_id): $dir"
      continue
    fi

    # Rule 4: never touch a directory an active process has open
    if [ -n "$(/usr/sbin/lsof +D "$dir" 2>/dev/null)" ]; then
      skipped_open=$((skipped_open + 1))
      log "skip (open handles): $dir"
      continue
    fi

    if [ "$DRY_RUN" = "1" ]; then
      dry_deleted=$((dry_deleted + 1))
      log "dry-run would delete: $dir"
      continue
    fi

    if rm -rf "$dir"; then
      deleted=$((deleted + 1))
      log "deleted: $dir"
    else
      log "FAILED to delete: $dir"
    fi
  done < <(find "$work" -mindepth 1 -maxdepth 1 -type d -mmin +"$((MAX_AGE_DAYS * 1440))" -print0)
done

log "cleanup finished: deleted=$deleted dry_run=$dry_deleted skipped_active=$skipped_active skipped_open=$skipped_open"
exit 0
