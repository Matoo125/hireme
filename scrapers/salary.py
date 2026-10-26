"""Read the boards' free-text salary into numbers.

parse_salary("$80K – $145K / £50K – £90K") gives
    {"salary_min": "80000", "salary_max": "145000",
     "salary_currency": "USD", "salary_period": "year"}

The text stays in `salary_range`; these are extra columns, left empty
whenever the text doesn't say. Rules:

  - Currency: the first one the text mentions. Its smallest and largest
    amounts are min and max, which is right for per-location variants
    ("$241,000 (NYC) / $219,000 (elsewhere)"); amounts in other currencies
    (often the same pay converted) are ignored. A bare "$" is USD unless
    the text says CAD/C$ or AUD/A$; "lakh" means INR. Text with no
    currency at all ("24000 to 80000") still gives min/max, with the
    currency empty.
  - In a range, a k/million or currency on one end applies to both
    ("£40k - 65k", "$40 - $50 CAD", "£93,000–121,000").
  - "Up to X" is a max, "Starting: X" a min; one amount is both.
  - Period: stated ("per hour", "/month", "pro-rata" = year, a grant or
    award = total) or, when not stated, "year" for amounts of 10,000 or
    more in USD/GBP/EUR/CAD/AUD/CHF. Otherwise empty.
  - "Unpaid" is 0, period "unpaid". "Competitive" and the like: all empty.
"""

import re

SYMBOLS = {"£": "GBP", "€": "EUR", "A$": "AUD", "US$": "USD", "C$": "CAD"}
CODES = {"USD", "GBP", "EUR", "CAD", "AUD", "CHF", "CZK", "INR", "NGN", "KRW", "ZAR", "KES", "SGD", "NZD"}
YEARLY_CURRENCIES = {"USD", "GBP", "EUR", "CAD", "AUD", "CHF"}

_MULTIPLIERS = {"k": 1_000, "m": 1_000_000, "million": 1_000_000, "mn": 1_000_000}

# One amount: optional currency before, the number, optional k/million and
# optional currency code after.
_AMOUNT_RE = re.compile(
    r"(?P<pre>US\$|A\$|C\$|[$£€]|\b(?:" + "|".join(CODES) + r")\b)?\s*"
    r"(?P<num>\d[\d,]*(?:\.\d+)?)"
    r"(?:\s*(?P<mult>million|mn|k|m)\b)?"
    r"(?:\s*(?P<post>\b(?:" + "|".join(CODES) + r")\b|€))?",
    re.IGNORECASE,
)
# What may sit between the two ends of a range.
_RANGE_GAP_RE = re.compile(r"^\s*(?:-|–|—|to)\s*$", re.IGNORECASE)

_PERIODS = [
    ("hour", r"per\s+hour|/\s*h(?:ou)?r\b|hourly|an\s+hour"),
    ("day", r"per\s+day|/\s*day\b|daily"),
    ("week", r"per\s+week|/\s*week\b|weekly"),
    ("month", r"per\s+month|/\s*month\b|monthly|a\s+month"),
    ("year", r"per\s+(?:year|annum)|/\s*(?:year|yr)\b|annual|a\s+year|for\s+the\s+year|pro[\s-]?rata"),
    ("total", r"grant|award|funding|runway|per\s+session|/\s*project|per\s+project|cohort|\btotal\b|for\s+~?\s*\w+\s*(?:\(\d+\)\s*)?months"),
]
_UNPAID_RE = re.compile(r"\bunpaid\b|\bvolunteer\b", re.IGNORECASE)
_UP_TO_RE = re.compile(r"^\s*up\s+to\b", re.IGNORECASE)
_STARTING_RE = re.compile(r"^\s*(?:starting|from)\b", re.IGNORECASE)

EMPTY = {"salary_min": "", "salary_max": "", "salary_currency": "", "salary_period": ""}


def _currency(token, text):
    if not token:
        return None
    token = token.upper()
    if token == "$":
        upper = text.upper()
        if "CAD" in upper or "C$" in upper:
            return "CAD"
        if "AUD" in upper or "A$" in upper:
            return "AUD"
        return "USD"
    return SYMBOLS.get(token, token if token in CODES else None)


def _amounts(text):
    """[(value, currency or None)] in order, ranges sharing multiplier and currency."""
    found = []
    for m in _AMOUNT_RE.finditer(text):
        raw = m.group("num").replace(",", "")
        # A comma-grouped number like "6,00,000" (Indian grouping) parses fine
        # this way; a stray digit in a word ("L3", "6-month") is dropped below.
        value = float(raw)
        mult = (m.group("mult") or "").lower()
        currency = _currency(m.group("pre"), text) or _currency(m.group("post"), text)
        found.append({"value": value, "mult": mult, "currency": currency,
                      "start": m.start(), "end": m.end(), "num_start": m.start("num")})
    # Ranges: "A - B" shares multiplier and currency between its ends.
    for a, b in zip(found, found[1:]):
        if _RANGE_GAP_RE.match(text[a["end"]:b["start"]]) or _RANGE_GAP_RE.match(text[a["end"]:b["num_start"]]):
            a["mult"] = a["mult"] or b["mult"]
            b["mult"] = b["mult"] or a["mult"]
            a["currency"] = a["currency"] or b["currency"]
            b["currency"] = b["currency"] or a["currency"]
            a["ranged"] = b["ranged"] = True
    out = []
    for f in found:
        value = f["value"] * _MULTIPLIERS.get(f["mult"], 1)
        # A bare number glued to a word ("L3", "6-month", "(4)") isn't pay.
        if f["currency"] is None and not f.get("ranged") and value < 1000:
            continue
        out.append((value, f["currency"]))
    return out


def _number(value):
    return str(int(value)) if value == int(value) else f"{value:.2f}".rstrip("0").rstrip(".")


def parse_salary(text):
    text = (text or "").strip()
    if not text:
        return dict(EMPTY)
    if _UNPAID_RE.search(text) and not re.search(r"\d", text):
        return {"salary_min": "0", "salary_max": "0", "salary_currency": "", "salary_period": "unpaid"}

    amounts = _amounts(text)
    if not amounts:
        return dict(EMPTY)
    currency = next((c for _, c in amounts if c), None)
    values = [v for v, c in amounts if c == currency] if currency else [v for v, _ in amounts]
    if currency is None and re.search(r"\blakhs?\b", text, re.IGNORECASE):
        currency = "INR"
    if not values:
        return dict(EMPTY)

    low, high = min(values), max(values)
    if len(values) == 1:
        if _UP_TO_RE.search(text):
            low = None
        elif _STARTING_RE.search(text):
            high = None

    period = ""
    for name, pattern in _PERIODS:
        if re.search(pattern, text, re.IGNORECASE):
            period = name
            break
    if not period and currency in YEARLY_CURRENCIES and (high or low) >= 10_000:
        period = "year"

    return {
        "salary_min": "" if low is None else _number(low),
        "salary_max": "" if high is None else _number(high),
        "salary_currency": currency or "",
        "salary_period": period,
    }
