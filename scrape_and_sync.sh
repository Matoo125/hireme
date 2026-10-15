#!/bin/bash
# Run the daily scrape, then always sync jobs.csv to Airtable afterward -
# even if a board failed, since scrape_jobs.py still writes jobs.csv from
# whichever boards succeeded and exits non-zero only to flag the degraded
# run (see scrape_jobs.py). Chaining via systemd ExecStart= lines would
# skip the sync whenever any board fails, so this wrapper decouples the two
# while still surfacing either failure to systemd for `systemctl --failed`.
#
# The refreshed jobs.csv is also committed and pushed to git, so the repo
# snapshot (and the deployed copy, via auto-deploy) always matches the live
# data instead of drifting until someone commits manually.
set -uo pipefail
cd "$(dirname "$0")"

python3 scrape_jobs.py -o jobs.csv
scrape_status=$?

python3 sync_airtable.py -i jobs.csv
sync_status=$?

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

if [ "$sync_status" -ne 0 ]; then
    exit "$sync_status"
fi
exit "$scrape_status"
