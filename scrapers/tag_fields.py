"""Sort a job's tags into typed columns.

The boards' tags mix what a job *is* (full-time, a fellowship), who it's for
(junior, a master's degree), where (remote, London), what cause it serves
and what work it involves. TAG_FIELDS says which column each tag belongs to
and under what value, which is also where each board's own wording of the
same thing is merged ("Mid (5–9y)", "Mid (5-9 years experience)",
"Mid-senior level" are all "Mid (5–9y)").

Tags are matched with normalize.tag_key, so case and punctuation don't
matter. A tag can feed more than one value ("Research or data"). Tags in
no typed column go to `other_tags`, and the ones not even in UNTYPED are
named in the scrape log, so this table can grow when a board adds new
ones. `tags` itself keeps every tag as before.
"""

from scrapers.normalize import tag_key

# The typed columns, in CSV order, and their headings in the web app.
FIELDS = {
    "job_type": "Type",
    "experience": "Experience",
    "education": "Education",
    "location": "Location",
    "cause_area": "Cause area",
    "skills": "Skills",
}

_TABLE = {
    "job_type": {
        "Full-time": ["Full-time"],
        "Part-time": ["Part-time", "Part-Time (50–80% FTE)", "Part-Time (<50% FTE)"],
        "Internship": ["Internship"],
        "Fellowship": ["Fellowship"],
        "Volunteer": ["Volunteer", "Volunteering"],
        "Course": ["Course"],
        "Training": ["Training"],
        "Funding": ["Funding"],
        "Expression of interest": ["Expression of Interest"],
    },
    "experience": {
        "Entry-level": ["Entry-level"],
        "Junior (1–4y)": ["Junior (1–4y)", "Junior (1-4 years experience)"],
        "Mid (5–9y)": ["Mid (5–9y)", "Mid (5-9 years experience)", "Mid-senior level"],
        "Senior (10y+)": ["Senior (10y+)", "Senior (10+ years experience)"],
        "Director / executive": ["Director", "Executive"],
        "Multiple levels": ["Multiple experience levels"],
    },
    "education": {
        "High school": ["High school"],
        "Undergraduate degree or less": ["Undergraduate degree or less"],
        "Undergraduate degree": ["Undergraduate degree"],
        "Graduate degree": ["Graduate degree", "Master's degree"],
        "Doctoral degree": ["Doctoral degree"],
        "Specialized degree (M.D., J.D., …)": ["Specialized degree (M.D., J.D., etc.)"],
    },
    "location": {
        "Remote": ["Remote", "Remote, Global", "Remote, USA"],
        "Global": ["Global", "Remote, Global", "Worldwide", "Various, Global"],
        "USA": ["USA", "Remote, USA", "USA (Confirmed Visas)"],
        "USA (visa sponsored)": ["USA (Confirmed Visas)"],
        "UK": ["UK", "UK (Confirmed Visas)", "London, UK", "Oxford, UK"],
        "UK (visa sponsored)": ["UK (Confirmed Visas)"],
        "London": ["London, UK"],
        "Oxford": ["Oxford, UK"],
        "San Francisco Bay Area": ["San Francisco Bay Area"],
        "Washington, DC": ["Washington, DC metro area"],
        "Los Angeles": ["Los Angeles, CA"],
        "New York": ["New York, NY"],
        "Pittsburgh": ["Pittsburgh, PA"],
    },
    "cause_area": {
        "AI safety & policy": ["AI safety & policy"],
        "Global health & development": ["Global health & development"],
        "Animal welfare": ["Animal welfare"],
        "Biosecurity & pandemic preparedness": ["Biosecurity & pandemic preparedness", "Biosecurity"],
        "Climate change": ["Climate change"],
        "Building effective altruism": ["Building effective altruism"],
        "Global priorities research": ["Global priorities research", "Macrostrategy"],
        "Nuclear security & conflict": ["Nuclear Security & Conflict", "Nuclear security"],
        "International security & cooperation": ["International security & cooperation"],
        "Institutional decision-making": ["Institutional decision-making"],
        "Mental health & wellbeing": ["Mental health & wellbeing"],
        "Societal improvements": ["Societal Improvements"],
        "Other": ["Other policy-focused", "Other (pressing)"],
    },
    "skills": {
        "Research": ["Research", "Research or data"],
        "Data": ["Data", "Research or data"],
        "Operations": ["Operations", "Operations or administration"],
        "Management": ["Management"],
        "Project management": ["Project or programme management"],
        "Leadership": ["Leadership"],
        "Strategy": ["Strategy"],
        "Communications": ["Communication", "Communications", "Communications & Outreach", "Marketing or communications"],
        "Community building": ["Community building"],
        "Organization building": ["Organization building, boosting & running"],
        "Software engineering": ["Software engineering"],
        "Engineering": ["Engineering", "Technical"],
        "Information security": ["Information security"],
        "Policy": ["Policy", "Policy writing", "Political & bureaucratic"],
        "AI governance": ["AI governance understanding"],
        "Legal": ["Legal", "Legal or law"],
        "Finance": ["Finance"],
        "Fundraising": ["Fundraising or development"],
        "Grantmaking": ["Grantmaker"],
        "Campaigns": ["Campaigns and corporate engagement"],
        "Human resources": ["Human resources"],
        "Entrepreneurship": ["Entrepreneur"],
        "Forecasting": ["Forecasting"],
        "Academia": ["Academia"],
        "Collaborative problem-solving": ["Collaborative problem-solving"],
    },
}

# tag_key(tag) -> [(field, value), ...], built from _TABLE.
TAG_FIELDS = {}
for _field, _values in _TABLE.items():
    for _value, _tags in _values.items():
        for _tag in _tags:
            TAG_FIELDS.setdefault(tag_key(_tag), []).append((_field, _value))

# Tags that are known and deliberately left in `tags` only: the EA board's
# "why this matters" categories, languages, catch-alls.
UNTYPED = {tag_key(t) for t in [
    "Direct high impact on an important cause",
    "Skill-building & building career capital",
    "Career-Capital",
    "Direct/increased engagement with EA",
    "Testing your fit for a certain career path",
    "Learning about important cause areas",
    "Career development",
    "English",
    "Nonprofit",
    "Profit for Good",
    "Other",
    "All",
]}


def classify_tags(tags):
    """{field: "value; value"} for a job's `tags` string (FIELDS plus
    other_tags), and the tags neither in TAG_FIELDS nor in UNTYPED."""
    out = {field: [] for field in FIELDS}
    other = []
    unknown = []
    for tag in (t.strip() for t in (tags or "").split(";")):
        if not tag:
            continue
        key = tag_key(tag)
        for field, value in TAG_FIELDS.get(key, []):
            if value not in out[field]:
                out[field].append(value)
        if key not in TAG_FIELDS:
            other.append(tag)
            if key not in UNTYPED:
                unknown.append(tag)
    fields = {field: "; ".join(values) for field, values in out.items()}
    fields["other_tags"] = "; ".join(other)
    return fields, unknown
