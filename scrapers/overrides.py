"""Hand corrections to scraped jobs that survive the next scrape.

overrides.toml (next to jobs.csv) has one table per job id, giving the
values to use instead of what the boards say:

    ["693b22fe938f"]  # Human Resources Associate, Centre for Effective Altruism
    close_date = 2026-11-30
    salary_range = "$79,200 - $90,000 per year"

Any column but `id` and `corrected` can be set. They are applied after
deduplication and before the typed columns and salary numbers are
derived, so correcting `tags` or `salary_range` corrects those too;
setting a derived column (`salary_period`, `location`, ...) directly wins
over the derived value. `corrected` lists the columns set, per job.

The scrape keeps the deduplicated jobs as scraped, before any of this, in
data/scraped.json, so a correction can be made or undone without scraping
again: the web app's grid (for admins) runs

    python3 -m scrapers.overrides set <job id>  < {"field": "value" or null}

which edits overrides.toml in place (keeping its comments; null removes a
correction, and so does a value the scrape gives by itself), rebuilds
jobs.csv from data/scraped.json and prints the job's new row as JSON.
With --commit it also commits both files and pushes, since uncommitted
changes would stop the next deploy. After editing overrides.toml by hand,

    python3 -m scrapers.overrides rebuild

does the same rebuild of jobs.csv, without scraping again.

The scrape log names overrides whose job wasn't scraped this time (it
closed, or its link changed and with it the id) and values the scrape now
gives by itself, so either can be deleted. A broken file is reported as a
problem and the scrape goes on without it.

Find a job's id with: python3 -m scrapers.overrides find <words from title or org>
"""

import argparse
import contextlib
import csv
import datetime
import fcntl
import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

from scrapers.common import FIELDNAMES
from scrapers.salary import parse_salary
from scrapers.tag_fields import FIELDS, classify_tags

OVERRIDABLE = [f for f in FIELDNAMES if f not in ("id", "corrected")]
# Columns holding ";"-separated values.
LIST_FIELDS = {"tags", "other_tags", *FIELDS}
DATE_FIELDS = {"publication_date", "close_date"}
PERIODS = {"year", "month", "week", "day", "hour", "total", "unpaid"}


class OverridesError(Exception):
    pass


class UnknownJob(OverridesError):
    pass


def _value(job_id, field, value):
    if isinstance(value, str):
        return value
    if isinstance(value, datetime.date) and not isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(int(value)) if value == int(value) else str(value)
    raise OverridesError(f'["{job_id}"] {field}: expected text, a number or a date, got {value!r}')


def parse_overrides(text):
    """{job id: {field: value}} from overrides.toml's text."""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise OverridesError(str(exc)) from exc
    out = {}
    for job_id, fields in data.items():
        if not isinstance(fields, dict):
            raise OverridesError(f'{job_id} = ...: each job needs its own ["<id>"] table')
        unknown = [f for f in fields if f not in OVERRIDABLE]
        if unknown:
            raise OverridesError(f'["{job_id}"]: not a column that can be overridden: {", ".join(unknown)}')
        out[job_id] = {field: _value(job_id, field, v) for field, v in fields.items()}
    return out


def load_overrides(path):
    """parse_overrides of the file at path; {} if it doesn't exist."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    return parse_overrides(text)


# ── Applying ────────────────────────────────────────────────────────────────


def derive(job):
    """The columns computed from tags and salary_range."""
    fields, _ = classify_tags(job.get("tags"))
    fields.update(parse_salary(job.get("salary_range")))
    return fields


def apply_override(job, override, derive=derive):
    """Set override's values on job, then fill in derive(job)'s columns
    except the overridden ones. Returns the overridden fields whose value
    the scrape gives by itself anyway."""
    scraped = {field: job.get(field, "") for field in override}
    job.update(override)
    derived = derive(job)
    job.update({k: v for k, v in derived.items() if k not in override})
    job["corrected"] = "; ".join(f for f in FIELDNAMES if f in override)
    return [f for f, v in override.items() if (derived[f] if f in derived else scraped[f]) == v]


def finish(scraped, overrides):
    """jobs.csv's rows from the deduplicated jobs and the overrides, and
    the "id.field" overrides the scrape now gives by itself."""
    rows, redundant = [], []
    for job in scraped:
        row = dict(job)
        redundant += [f"{row['id']}.{f}" for f in apply_override(row, overrides.get(row["id"], {}))]
        rows.append(row)
    return rows, redundant


def _write_atomically(path, write):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        write(f)
    os.replace(tmp, path)


def write_csv(path, rows):
    def write(f):
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    _write_atomically(path, write)


def save_scraped(path, jobs):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    _write_atomically(path, lambda f: json.dump(jobs, f, ensure_ascii=False))


# ── Editing overrides.toml ──────────────────────────────────────────────────

_ANY_HEADER_RE = re.compile(r"^\s*\[")


def _header_re(job_id):
    key = re.escape(job_id)
    return re.compile(rf"""^\s*\[\s*(?:"{key}"|'{key}'|{key})\s*\]""")


def _key_re(field):
    key = re.escape(field)
    return re.compile(rf"""^\s*(?:"{key}"|'{key}'|{key})\s*=""")


def toml_string(value):
    out = []
    for ch in value:
        if ch in '"\\':
            out.append("\\" + ch)
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def edit_text(text, job_id, changes, comment=""):
    """overrides.toml's text with job_id's table changed: {field: value}
    sets, {field: None} removes. A table left empty is removed; a new one
    goes at the end, with comment after its header. Line by line, so the
    rest of the file (comments too) stays as it was."""
    lines = text.splitlines()
    header = _header_re(job_id)
    start = next((i for i, line in enumerate(lines) if header.match(line)), None)
    if start is None:
        if all(v is None for v in changes.values()):
            return text
        while lines and not lines[-1].strip():
            lines.pop()
        if lines:
            lines.append("")
        lines.append(f'["{job_id}"]' + (f"  # {comment}" if comment else ""))
        start = len(lines) - 1
    end = next((i for i in range(start + 1, len(lines)) if _ANY_HEADER_RE.match(lines[i])), len(lines))
    section = lines[start + 1:end]

    for field, value in changes.items():
        key = _key_re(field)
        at = next((i for i, line in enumerate(section) if key.match(line)), None)
        line = None if value is None else f"{field} = {toml_string(value)}"
        if at is not None and line is None:
            del section[at]
        elif at is not None:
            section[at] = line
        elif line is not None:
            last = max((i for i, s in enumerate(section) if s.strip()), default=-1)
            section.insert(last + 1, line)

    if any(re.match(r"^\s*[\w\"']", s) for s in section):
        lines[start + 1:end] = section
    else:
        # Nothing left to set: drop the table, and the blank line before it.
        del lines[start:end]
        if start > 0 and not lines[start - 1].strip() and (start == len(lines) or not lines[start].strip()):
            del lines[start - 1]
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines) + "\n" if lines else ""


def clean_value(field, value):
    """value as stored, or OverridesError when it can't be one for field."""
    if field not in OVERRIDABLE:
        raise OverridesError(f"{field}: not a column that can be overridden")
    if not isinstance(value, str):
        raise OverridesError(f"{field}: expected text")
    value = value.strip()
    if not value:
        return ""
    if field in LIST_FIELDS:
        parts = []
        for part in (p.strip() for p in value.split(";")):
            if part and part not in parts:
                parts.append(part)
        return "; ".join(parts)
    if field in DATE_FIELDS:
        try:
            return datetime.date.fromisoformat(value).isoformat()
        except ValueError:
            raise OverridesError(f"{field}: expected a date like 2026-11-30, got {value!r}") from None
    if field in ("salary_min", "salary_max"):
        plain = re.sub(r"[,\s_]", "", value)
        if not re.fullmatch(r"\d+(\.\d+)?", plain):
            raise OverridesError(f"{field}: expected an amount like 80,000, got {value!r}")
        number = float(plain)
        return str(int(number)) if number == int(number) else str(number)
    if field == "salary_currency":
        if not re.fullmatch(r"[A-Za-z]{3}", value):
            raise OverridesError(f"{field}: expected a currency code like USD, got {value!r}")
        return value.upper()
    if field == "salary_period":
        if value not in PERIODS:
            raise OverridesError(f"{field}: expected one of {', '.join(sorted(PERIODS))}, got {value!r}")
    return value


def set_overrides(job_id, patch, overrides_path, scraped_path, jobs_path):
    """Apply patch ({field: value or None}) to job_id's overrides, rebuild
    jobs.csv, and return the job's new row."""
    scraped = json.loads(Path(scraped_path).read_text(encoding="utf-8"))
    raw = next((job for job in scraped if job["id"] == job_id), None)
    if raw is None:
        raise UnknownJob(f"job {job_id} isn't in the last scrape")
    path = Path(overrides_path)
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    overrides = parse_overrides(text)

    current = dict(overrides.get(job_id, {}))
    for field, value in patch.items():
        if value is None:
            current.pop(field, None)
        else:
            current[field] = clean_value(field, value)
    # A value the scrape gives by itself needs no override: setting a cell
    # back to what the board says undoes the correction.
    for field in [f for f in patch if f in current]:
        without = {f: v for f, v in current.items() if f != field}
        row = dict(raw)
        apply_override(row, without)
        if row.get(field, "") == current[field]:
            del current[field]

    changes = {f: current.get(f) for f in patch}
    comment = " - ".join(v for v in (raw.get("title"), raw.get("organization_name")) if v)
    new_text = edit_text(text, job_id, changes, comment)
    expected = dict(overrides)
    if current:
        expected[job_id] = current
    else:
        expected.pop(job_id, None)
    if parse_overrides(new_text) != expected:
        raise OverridesError(f"couldn't edit {path.name} line by line here; edit it by hand")
    if new_text != text:
        _write_atomically(path, lambda f: f.write(new_text))
    rows, _ = finish(scraped, expected)
    write_csv(jobs_path, rows)
    return next(row for row in rows if row["id"] == job_id)


def commit(paths, message):
    """Commit paths (if changed) and push; a failed push only warns, the
    next scrape's push carries the commit."""
    repo = Path(paths[0]).resolve().parent
    names = [str(Path(p).resolve()) for p in paths]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *names], cwd=repo).returncode == 0:
        return
    subprocess.run(["git", "commit", "--quiet", "-m", message, "--", *names], cwd=repo, check=True, env=env)
    if subprocess.run(["git", "push", "--quiet", "origin", "HEAD"], cwd=repo, env=env).returncode != 0:
        print("warning: git push failed; the next scrape pushes this commit", file=sys.stderr)


def _find(words, csv_path="jobs.csv"):
    words = [w.lower() for w in words]
    with open(csv_path, newline="", encoding="utf-8") as f:
        for job in csv.DictReader(f):
            text = f"{job['title']} {job['organization_name']}".lower()
            if all(w in text for w in words):
                print(f"{job['id']}  {job['title']} - {job['organization_name']}")


@contextlib.contextmanager
def _jobs_lock(scraped_path):
    """The lock scrape_and_sync.sh holds, so a scrape and an edit don't
    write jobs.csv over each other."""
    with open(Path(scraped_path).parent / ".jobs.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def main():
    parser = argparse.ArgumentParser(prog="python3 -m scrapers.overrides")
    sub = parser.add_subparsers(dest="command", required=True)
    find = sub.add_parser("find", help="print the ids of jobs whose title or org has all the words")
    find.add_argument("words", nargs="+")
    find.add_argument("--jobs", default="jobs.csv")
    edit = sub.add_parser("set", help="change a job's overrides from a JSON object on stdin")
    edit.add_argument("job_id")
    edit.add_argument("--jobs", default="jobs.csv")
    edit.add_argument("--overrides", default="overrides.toml")
    edit.add_argument("--scraped", default="data/scraped.json")
    edit.add_argument("--commit", action="store_true", help="commit and push overrides.toml and jobs.csv")
    rebuild = sub.add_parser("rebuild", help="rebuild jobs.csv from the last scrape and overrides.toml")
    rebuild.add_argument("--jobs", default="jobs.csv")
    rebuild.add_argument("--overrides", default="overrides.toml")
    rebuild.add_argument("--scraped", default="data/scraped.json")
    args = parser.parse_args()

    if args.command == "find":
        _find(args.words, args.jobs)
        return
    if args.command == "rebuild":
        with _jobs_lock(args.scraped):
            try:
                overrides = load_overrides(args.overrides)
            except OverridesError as exc:
                sys.exit(f"{args.overrides}: {exc}")
            scraped = json.loads(Path(args.scraped).read_text(encoding="utf-8"))
            rows, redundant = finish(scraped, overrides)
            write_csv(args.jobs, rows)
        ids = {row["id"] for row in rows}
        print(f"Wrote {len(rows)} jobs to {args.jobs}, {sum(1 for i in overrides if i in ids)} corrected")
        stale = [i for i in overrides if i not in ids]
        if stale:
            print(f"Overrides for jobs not in the last scrape: {', '.join(stale)}")
        if redundant:
            print(f"Overrides the scrape now matches: {', '.join(redundant)}")
        return
    try:
        patch = json.load(sys.stdin)
        if not isinstance(patch, dict) or not patch:
            raise ValueError
    except ValueError:
        sys.exit('expected a JSON object like {"close_date": "2026-11-30"} on stdin')
    with _jobs_lock(args.scraped):
        try:
            row = set_overrides(args.job_id, patch, args.overrides, args.scraped, args.jobs)
        except UnknownJob as exc:
            print(exc, file=sys.stderr)
            sys.exit(3)
        except OverridesError as exc:
            print(exc, file=sys.stderr)
            sys.exit(2)
        if args.commit:
            title = row.get("title") or args.job_id
            verb = "Undo correction to" if all(v is None for v in patch.values()) else "Correct"
            commit([args.overrides, args.jobs], f"{verb} {title}: {', '.join(patch)}")
    json.dump(row, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
