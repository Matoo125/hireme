#!/bin/bash
# Run the daily scrape, then commit and push the refreshed jobs.csv, so the
# repo snapshot (and the deployed copy, via auto-deploy) always matches the
# live data instead of drifting until someone commits manually.
#
# The commit happens even if a board failed, since scrape_jobs.py still
# writes jobs.csv from whichever boards succeeded and exits non-zero only to
# flag the degraded run (see scrape_jobs.py); that status is passed on to
# systemd at the end, for `systemctl --failed`.
set -uo pipefail
cd "$(dirname "$0")"

# Held for the whole run: edits from the web app's grid (scrapers/overrides.py
# set) take the same lock, so neither writes jobs.csv or commits mid-way
# through the other.
mkdir -p data
exec 9>data/.jobs.lock
flock 9

python3 scrape_jobs.py -o jobs.csv
scrape_status=$?

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
        exit 1
    fi
    git push --quiet origin main || { echo "!!! git push of jobs.csv FAILED" >&2; exit 1; }
    echo "committed and pushed jobs.csv"
fi

exit "$scrape_status"
