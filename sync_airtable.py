#!/usr/bin/env python3
"""
Sync jobs.csv to an Airtable table with the same column structure.

Upserts rows from jobs.csv into Airtable (matched on the `id` field),
then deletes any Airtable record whose `id` is no longer present in
jobs.csv, so the table exactly mirrors the CSV.

Only rows that are new or changed since the last sync are sent. A local
state file (STATE_PATH: per-row content hash plus Airtable record ID)
remembers what was last synced, which keeps a daily run to a handful of
API calls instead of re-upserting every row - the free plan's monthly
request cap ran out within weeks that way. Stale rows are deleted via
their stored record IDs, so no table read is needed either. With no state
file (first run) or --full, every row is upserted and stale records are
found by listing the table, as before. Use --full after editing the
Airtable table by hand, since the state file can't see those edits.

Requires an AIRTABLE_API_KEY (a personal access token with
data.records:read/write scope on the target base). Read from the
environment, or from a .env file in this directory (KEY=VALUE per
line, not committed to git). Base/table default to the hireme jobs
base but can be overridden.

Usage:
  python3 sync_airtable.py                      # reads AIRTABLE_API_KEY from .env or env
  AIRTABLE_API_KEY=pat... python3 sync_airtable.py
  python3 sync_airtable.py -i jobs.csv --base appXXXXXXXX --table tblXXXXXXXX
  python3 sync_airtable.py --full               # ignore the state file, resync everything
"""

import argparse
import csv
import hashlib
import os
import sys
import time
import urllib.error
import urllib.request
import json

from scrapers.common import FIELDNAMES

DEFAULT_BASE = "appgt87HxTF26Orqm"
DEFAULT_TABLE = "tblfsRXS8O14THOpG"
API_ROOT = "https://api.airtable.com/v0"
BATCH_SIZE = 10
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "airtable-sync-state.json")


def load_dotenv(path=ENV_PATH):
    """Populate os.environ from a simple KEY=VALUE .env file, without overriding
    variables already set in the environment."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def api_request(method, url, api_key, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code} on {method} {url}: {body}", file=sys.stderr)
        raise


def load_csv_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    return rows


def load_state(path=STATE_PATH):
    """Return {row id: {"record": Airtable record ID, "hash": row hash}} from the last sync."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_state(state, path=STATE_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=0, sort_keys=True)
    os.replace(tmp, path)


def row_hash(row):
    fields = {k: row.get(k, "") for k in FIELDNAMES}
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode("utf-8")).hexdigest()


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def upsert_rows(rows, api_key, base, table, state):
    """Upsert rows, recording each one's record ID and hash in `state` as its batch succeeds."""
    url = f"{API_ROOT}/{base}/{table}"
    for batch in chunked(rows, BATCH_SIZE):
        payload = {
            "performUpsert": {"fieldsToMergeOn": ["id"]},
            "typecast": True,
            "records": [
                {"fields": {k: row.get(k, "") for k in FIELDNAMES}} for row in batch
            ],
        }
        data = api_request("PATCH", url, api_key, payload)
        record_ids = {r["fields"].get("id"): r["id"] for r in data["records"]}
        for row in batch:
            state[row["id"]] = {"record": record_ids[row["id"]], "hash": row_hash(row)}
        time.sleep(0.2)


def fetch_all_records(api_key, base, table):
    records = []
    offset = None
    while True:
        url = f"{API_ROOT}/{base}/{table}?pageSize=100&fields%5B%5D=id"
        if offset:
            url += f"&offset={offset}"
        data = api_request("GET", url, api_key)
        records.extend(data["records"])
        offset = data.get("offset")
        if not offset:
            break
        time.sleep(0.2)
    return records


def delete_records(record_ids, api_key, base, table):
    url = f"{API_ROOT}/{base}/{table}"
    for batch in chunked(record_ids, BATCH_SIZE):
        qs = "&".join(f"records%5B%5D={rid}" for rid in batch)
        api_request("DELETE", f"{url}?{qs}", api_key)
        time.sleep(0.2)


def delete_stale_records(csv_ids, api_key, base, table, state, full):
    """Delete records whose `id` is no longer in the CSV, and drop them from `state`.

    Incremental runs take the stale record IDs from `state`; full runs list the table
    instead, which also catches records the state file never knew about."""
    if full:
        all_records = fetch_all_records(api_key, base, table)
        stale = {r["fields"].get("id"): r["id"] for r in all_records if r["fields"].get("id") not in csv_ids}
    else:
        stale = {row_id: entry["record"] for row_id, entry in state.items() if row_id not in csv_ids}
    delete_records(list(stale.values()), api_key, base, table)
    for row_id in stale:
        state.pop(row_id, None)
    return len(stale)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-i", "--input", default="jobs.csv", help="Input CSV path (default: %(default)s)")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Airtable base ID")
    parser.add_argument("--table", default=DEFAULT_TABLE, help="Airtable table ID or name")
    parser.add_argument("--no-delete", action="store_true", help="Skip deleting stale records not present in the CSV")
    parser.add_argument("--full", action="store_true", help="Ignore the sync state file: upsert every row and list the table to find stale records")
    args = parser.parse_args()

    load_dotenv()
    api_key = os.environ.get("AIRTABLE_API_KEY")
    if not api_key:
        print("AIRTABLE_API_KEY env var is required", file=sys.stderr)
        sys.exit(1)

    rows = load_csv_rows(args.input)
    print(f"Read {len(rows)} rows from {args.input}")

    state = {} if args.full else load_state()
    full = not state
    if full:
        print("No sync state (first run or --full) - doing a full sync.")
    changed = [row for row in rows if state.get(row["id"], {}).get("hash") != row_hash(row)]

    try:
        print(f"Upserting {len(changed)} new/changed of {len(rows)} records to Airtable base {args.base} table {args.table}...")
        upsert_rows(changed, api_key, args.base, args.table, state)
        print("Upsert complete.")

        if not args.no_delete:
            csv_ids = {row["id"] for row in rows}
            print("Checking for stale records to delete...")
            deleted = delete_stale_records(csv_ids, api_key, args.base, args.table, state, full)
            print(f"Deleted {deleted} stale record(s).")
    except BaseException:
        # An incremental run keeps its progress, so the next run only retries what
        # didn't make it. A failed full run saves nothing: a partial state file would
        # make the next run incremental, and it would never find stale records that
        # were in the table but not in the state file.
        if not full:
            save_state(state)
        raise
    save_state(state)


if __name__ == "__main__":
    main()
