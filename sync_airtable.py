#!/usr/bin/env python3
"""
Sync jobs.csv to an Airtable table with the same column structure.

Upserts every row in jobs.csv into Airtable (matched on the `id` field),
then deletes any Airtable record whose `id` is no longer present in
jobs.csv, so the table exactly mirrors the CSV.

Requires an AIRTABLE_API_KEY (a personal access token with
data.records:read/write scope on the target base). Read from the
environment, or from a .env file in this directory (KEY=VALUE per
line, not committed to git). Base/table default to the hireme jobs
base but can be overridden.

Usage:
  python3 sync_airtable.py                      # reads AIRTABLE_API_KEY from .env or env
  AIRTABLE_API_KEY=pat... python3 sync_airtable.py
  python3 sync_airtable.py -i jobs.csv --base appXXXXXXXX --table tblXXXXXXXX
"""

import argparse
import csv
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


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def upsert_rows(rows, api_key, base, table):
    url = f"{API_ROOT}/{base}/{table}"
    for batch in chunked(rows, BATCH_SIZE):
        payload = {
            "performUpsert": {"fieldsToMergeOn": ["id"]},
            "typecast": True,
            "records": [
                {"fields": {k: row.get(k, "") for k in FIELDNAMES}} for row in batch
            ],
        }
        api_request("PATCH", url, api_key, payload)
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


def delete_stale_records(csv_ids, api_key, base, table):
    all_records = fetch_all_records(api_key, base, table)
    stale = [r["id"] for r in all_records if r["fields"].get("id") not in csv_ids]
    if not stale:
        return 0
    url = f"{API_ROOT}/{base}/{table}"
    for batch in chunked(stale, BATCH_SIZE):
        qs = "&".join(f"records%5B%5D={rid}" for rid in batch)
        api_request("DELETE", f"{url}?{qs}", api_key)
        time.sleep(0.2)
    return len(stale)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-i", "--input", default="jobs.csv", help="Input CSV path (default: %(default)s)")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Airtable base ID")
    parser.add_argument("--table", default=DEFAULT_TABLE, help="Airtable table ID or name")
    parser.add_argument("--no-delete", action="store_true", help="Skip deleting stale records not present in the CSV")
    args = parser.parse_args()

    load_dotenv()
    api_key = os.environ.get("AIRTABLE_API_KEY")
    if not api_key:
        print("AIRTABLE_API_KEY env var is required", file=sys.stderr)
        sys.exit(1)

    rows = load_csv_rows(args.input)
    print(f"Read {len(rows)} rows from {args.input}")

    print(f"Upserting {len(rows)} records to Airtable base {args.base} table {args.table}...")
    upsert_rows(rows, api_key, args.base, args.table)
    print("Upsert complete.")

    if not args.no_delete:
        csv_ids = {row["id"] for row in rows}
        print("Checking for stale records to delete...")
        deleted = delete_stale_records(csv_ids, api_key, args.base, args.table)
        print(f"Deleted {deleted} stale record(s).")


if __name__ == "__main__":
    main()
