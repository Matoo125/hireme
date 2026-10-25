#!/bin/bash
# Run the daily scrape, then commit and push the refreshed jobs.csv, so the
# repo snapshot (and the deployed copy, via auto-deploy) always matches the
# live data instead of drifting until someone commits manually.
#
# The commit happens even if a board failed, since scrape_jobs.py still
# writes jobs.csv from whichever boards succeeded and exits non-zero only to
# flag the degraded run (see scrape_jobs.py); that status is passed on to
# systemd at the end, for `systemctl --failed`.
#
# With HEALTHCHECK_URL set (in the environment or as a line in the repo's
# .env), each run also reports to Healthchecks.io: a /start ping, then the
# exit status with the run's log, so a failed, hung or missing run alerts
# by email/push instead of waiting for someone to check systemctl.
set -uo pipefail
cd "$(dirname "$0")"

HEALTHCHECK_URL=${HEALTHCHECK_URL:-$(sed -n 's/^HEALTHCHECK_URL=//p' .env 2>/dev/null | tail -n 1)}

# Ping Healthchecks.io at $1 (a suffix of the check's URL); extra arguments go
# to curl. Never fails the run: a ping that can't get through is only logged.
ping_healthcheck() {
    [ -n "$HEALTHCHECK_URL" ] || return 0
    local suffix=$1
    shift
    curl -fsS -m 10 --retry 3 -o /dev/null "$@" "$HEALTHCHECK_URL$suffix" \
        || echo "!!! healthcheck ping to $suffix failed" >&2
}

scrape_and_sync() {
    # Held for the whole run: edits from the web app's grid (scrapers/overrides.py
    # set) take the same lock, so neither writes jobs.csv or commits mid-way
    # through the other.
    mkdir -p data
    exec 9>data/.jobs.lock
    flock 9

    # Unbuffered, so stdout and stderr stay in order through the pipe to tee.
    PYTHONUNBUFFERED=1 python3 scrape_jobs.py -o jobs.csv
    local scrape_status=$?

    REPO_ROOT=$(git rev-parse --show-toplevel)
    cd "$REPO_ROOT"
    export GIT_TERMINAL_PROMPT=0
    if git diff --quiet -- jobs.csv; then
        echo "jobs.csv unchanged - nothing to commit"
    else
        git add jobs.csv
        git commit -m "sync jobs" >/dev/null
        if ! git pull --rebase --autostash --quiet origin main; then
            echo "!!! git pull --rebase FAILED (jobs.csv may conflict) - aborting rebase" >&2
            git rebase --abort 2>/dev/null
            return 1
        fi
        git push --quiet origin main || { echo "!!! git push of jobs.csv FAILED" >&2; return 1; }
        echo "committed and pushed jobs.csv"
    fi

    return "$scrape_status"
}

ping_healthcheck /start
log=$(mktemp)
trap 'rm -f "$log"' EXIT
scrape_and_sync 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
# Healthchecks.io keeps the first 100 kB of a ping's body; the end of the log
# (the problems summary) is what matters.
tail -c 100000 "$log" | ping_healthcheck "/$status" --data-binary @-
exit "$status"
