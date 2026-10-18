"""Hand corrections to scraped jobs that survive the next scrape.

overrides.toml (next to jobs.csv) has one table per job id, giving the
values to use instead of what the boards say:

    ["693b22fe938f"]  # Human Resources Associate, Centre for Effective Altruism
    close_date = 2026-11-30
    salary_range = "$79,200 - $90,000 per year"

Any column but `id` can be set. They are applied after deduplication and
before the typed columns and salary numbers are derived, so correcting
`tags` or `salary_range` corrects those too; setting a derived column
(`salary_period`, `location`, ...) directly wins over the derived value.

The scrape log names overrides whose job wasn't scraped this time (it
closed, or its link changed and with it the id) and values the scrape now
gives by itself, so either can be deleted. A broken file is reported as a
problem and the scrape goes on without it.

Find a job's id with: python3 -m scrapers.overrides find <words from title or org>
"""

import csv
import datetime
import sys
import tomllib

from scrapers.common import FIELDNAMES

OVERRIDABLE = [f for f in FIELDNAMES if f != "id"]


class OverridesError(Exception):
    pass


def _value(job_id, field, value):
    if isinstance(value, str):
        return value
    if isinstance(value, datetime.date) and not isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(int(value)) if value == int(value) else str(value)
    raise OverridesError(f'["{job_id}"] {field}: expected text, a number or a date, got {value!r}')


def load_overrides(path):
    """{job id: {field: value}} from path; {} if the file doesn't exist."""
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except FileNotFoundError:
        return {}
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


def apply_override(job, override, derive):
    """Set override's values on job, then fill in derive(job)'s columns
    except the overridden ones. Returns the overridden fields whose value
    the scrape gives by itself anyway."""
    scraped = {field: job.get(field, "") for field in override}
    job.update(override)
    derived = derive(job)
    job.update({k: v for k, v in derived.items() if k not in override})
    return [f for f, v in override.items() if (derived[f] if f in derived else scraped[f]) == v]


def _find(words, csv_path="jobs.csv"):
    words = [w.lower() for w in words]
    with open(csv_path, newline="", encoding="utf-8") as f:
        for job in csv.DictReader(f):
            text = f"{job['title']} {job['organization_name']}".lower()
            if all(w in text for w in words):
                print(f"{job['id']}  {job['title']} - {job['organization_name']}")


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] != "find":
        sys.exit("usage: python3 -m scrapers.overrides find <words from title or org>")
    _find(sys.argv[2:])
