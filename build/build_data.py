#!/usr/bin/env python3
"""
Build the public student-facing dataset for the 4 Michigan polling locator.

Inputs (both already in the project, neither is re-derived here):
  reporting-auth/public/votepro-geo.json   complexes, precinct polygons, polls
  FM_Master_Turf_Tracker_OPERATIONAL.xlsx  city / zip / on-off-campus enrichment

Outputs (public-safe, no voter counts, no PII):
  data/dorms.json          schools, dorms, precincts, polls        (loaded first)
  data/precincts-geo.json  149 polygons for the address fallback   (lazy loaded)
"""
import json, os, re, datetime, collections

ROOT = os.path.expanduser("~/mnt/4 Michigan")
OUT  = os.path.join(ROOT, "4mi-polling-locator", "data")
os.makedirs(OUT, exist_ok=True)

geo = json.load(open(os.path.join(ROOT, "reporting-auth/public/votepro-geo.json")))

# ---------------------------------------------------------------- tracker join
import openpyxl
wb = openpyxl.load_workbook(os.path.join(ROOT, "FM_Master_Turf_Tracker_OPERATIONAL.xlsx"), read_only=True)
ws = wb["All Turf + Precinct"]
rows = list(ws.iter_rows(min_row=2, values_only=True))
wb.close()

def nz(v):
    s = "" if v is None else str(v).strip()
    return "" if s.lower() in ("", "none", "n/a", "#n/a", "nan") else s

def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())

# key: (school, building name) -> tracker row
trk = {}
for r in rows:
    school, name = nz(r[6]), nz(r[9])
    if not school or not name:
        continue
    trk.setdefault((norm(school), norm(name)), r)

# secondary key: rounded lat/lng, for rows whose name was edited downstream
trk_geo = {}
for r in rows:
    try:
        trk_geo.setdefault((round(float(r[58]), 4), round(float(r[59]), 4)), r)
    except (TypeError, ValueError):
        pass

STREET_FIX = [
    (r"\bWy\.?$", "Way"), (r"\bDr\.?$", "Drive"), (r"\bSt\.?$", "Street"),
    (r"\bRd\.?$", "Road"), (r"\bAve\.?$", "Avenue"), (r"\bBlvd\.?$", "Boulevard"),
    (r"\bLn\.?$", "Lane"), (r"\bCt\.?$", "Court"), (r"\bPkwy\.?$", "Parkway"),
    (r"\bCir\.?$", "Circle"), (r"\bPl\.?$", "Place"), (r"\bTer\.?$", "Terrace"),
]
DASHES = re.compile(r"\s*[\u2010-\u2015\u2212]\s*")
def undash(s):
    """House rule: no en or em dashes anywhere, including upstream names."""
    return DASHES.sub(", ", (s or "")).strip().strip(",").strip()

def tidy_street(s):
    s = re.sub(r"\s+", " ", (s or "").strip().rstrip(","))
    for pat, rep in STREET_FIX:
        s = re.sub(pat, rep, s, flags=re.I)
    return s

def clean_addr(raw):
    """Strip the dangling state and any trailing zip from the legacy addr string."""
    s = re.sub(r"\s+", " ", (raw or "").strip())
    s = re.sub(r"[,\s]+MI\.?\s*\d{5}(-\d{4})?$", "", s, flags=re.I)
    s = re.sub(r"[,\s]+MI\.?$", "", s, flags=re.I)
    return s.strip().rstrip(",")

# ------------------------------------------------------------------- precincts
prec = {}
for f in geo["precincts"]["features"]:
    p = f["properties"]
    poll = geo["polls"].get(p["code"]) or {}
    prec[p["code"]] = {
        "name":   undash(p.get("name", "")),
        "county": p.get("county", ""),
        "poll": {
            "name": (poll.get("name") or p.get("poll_name") or "").strip(),
            "addr": (poll.get("addr") or p.get("poll_addr") or "").strip(),
            "city": (poll.get("city") or p.get("poll_city") or "").strip(),
            "lat":  poll.get("lat"),
            "lng":  poll.get("lng"),
        },
    }
    # deliberately dropped: reg, active, youth, youth_pct, complexes, av_code, schools, region

# -------------------------------------------------------------------- campuses
camp = {c["key"]: c for c in geo["campuses"]}

# ----------------------------------------------------------------------- dorms
dorms, unmatched = [], 0
for i, c in enumerate(geo["complexes"]):
    row = trk.get((norm(c["school"]), norm(c["name"])))
    if row is None:
        try:
            row = trk_geo.get((round(float(c["lat"]), 4), round(float(c["lng"]), 4)))
        except (TypeError, ValueError):
            row = None
    if row is None:
        unmatched += 1

    bno    = nz(row[10]) if row else ""
    street = tidy_street(nz(row[11])) if row else ""
    city   = nz(row[12]) if row else ""
    zipc   = nz(row[14]) if row else ""
    oncamp = (nz(row[7]).lower().startswith("on")) if row else None
    turf   = nz(row[8]) if row else ""

    line1 = f"{bno} {street}".strip() if (bno and street) else clean_addr(c.get("addr"))
    if not line1 and street:
        line1 = street

    d = {
        "i":  i,
        "s":  c["school"],
        "n":  undash(re.sub(r"\s+", " ", c["name"]).strip()),
        "a":  line1,
        "c":  city,
        "z":  zipc,
        "lat": c["lat"], "lng": c["lng"],
        "p":  c["code"],
    }
    if c.get("approx"):    d["approx"] = 1
    if oncamp is True:     d["on"] = 1
    if turf:               d["t"] = turf
    dorms.append(d)

# --------------------------------------------------------------- school groups
by_school = collections.defaultdict(list)
for d in dorms:
    by_school[d["s"]].append(d["i"])

schools = []
for key, idxs in by_school.items():
    m = camp.get(key, {})
    cities = collections.Counter(dorms[i]["c"] for i in idxs if dorms[i]["c"])
    schools.append({
        "k": key,
        "n": undash(m.get("name", key)),
        "city": cities.most_common(1)[0][0] if cities else "",
        "lat": m.get("lat"), "lng": m.get("lng"),
        "region": m.get("region", ""),
        "count": len(idxs),
    })
schools.sort(key=lambda s: s["n"])

payload = {
    "meta": {
        "built": datetime.date.today().isoformat(),
        "snapshot": geo.get("snapshot", {}).get("built", ""),
        "election": {"date": "2026-11-03", "name": "Michigan General Election"},
        "sources": {
            "addresses": "FM Master Turf Tracker (operational)",
            "precincts": "Michigan 2026 Voting Precincts, state published layer",
            "polling":   "Precinct polling places, state published layer",
        },
        "confirmed": "",           # stamped by confirm_polls.py
        "counts": {"schools": len(schools), "dorms": len(dorms), "precincts": len(prec)},
    },
    "schools": schools,
    "dorms": dorms,
    "precincts": prec,
}

with open(os.path.join(OUT, "dorms.json"), "w") as fh:
    json.dump(payload, fh, separators=(",", ":"))

# polygons only, nothing else, for the off-campus address fallback
slim = {"type": "FeatureCollection", "features": [
    {"type": "Feature",
     "properties": {"code": f["properties"]["code"]},
     "geometry": f["geometry"]}
    for f in geo["precincts"]["features"]]}
with open(os.path.join(OUT, "precincts-geo.json"), "w") as fh:
    json.dump(slim, fh, separators=(",", ":"))

# ------------------------------------------------------------------ build report
miss_poll = [d for d in dorms if not prec.get(d["p"], {}).get("poll", {}).get("name")]
no_addr   = [d for d in dorms if not d["a"]]
no_city   = [d for d in dorms if not d["c"]]
print(f"schools        {len(schools)}")
print(f"dorms          {len(dorms)}   (tracker unmatched: {unmatched})")
print(f"precincts      {len(prec)}")
print(f"poll coverage  {len(dorms)-len(miss_poll)}/{len(dorms)}  ({(len(dorms)-len(miss_poll))/len(dorms)*100:.1f}%)")
print(f"missing addr   {len(no_addr)}")
print(f"missing city   {len(no_city)}")
print(f"approx geocode {sum(1 for d in dorms if d.get('approx'))}")
print(f"dorms.json     {os.path.getsize(os.path.join(OUT,'dorms.json'))/1024:.0f} KB")
print(f"geo.json       {os.path.getsize(os.path.join(OUT,'precincts-geo.json'))/1024:.0f} KB")
