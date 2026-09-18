#!/usr/bin/env python3
"""
Fill the missing municipality on dorm records by reverse geocoding their
verified lat/lng against the US Census geocoder. Keyless, authoritative,
build-time only: the result is cached to build/city_cache.json and baked
into dorms.json, so the shipped page makes no geocoding calls at runtime.
"""
import json, os, re, sys, concurrent.futures as cf, urllib.request, urllib.parse

HERE  = os.path.dirname(os.path.abspath(__file__))
DATA  = os.path.join(os.path.dirname(HERE), "data", "dorms.json")
CACHE = os.path.join(HERE, "city_cache.json")

cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
payload = json.load(open(DATA))
todo = [d for d in payload["dorms"]
        if not d.get("c") and f"{d['lat']},{d['lng']}" not in cache]
print(f"missing city: {sum(1 for d in payload['dorms'] if not d.get('c'))}   to look up now: {len(todo)}")

URL = ("https://geocoding.geo.census.gov/geocoder/geographies/coordinates"
       "?x={lng}&y={lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json")
SUFFIX = re.compile(r"\s+(city|township|charter township|village|town|CDP)$", re.I)

def tidy(name):
    return SUFFIX.sub("", (name or "").strip()).strip()

def lookup(d):
    key = f"{d['lat']},{d['lng']}"
    try:
        req = urllib.request.Request(URL.format(lat=d["lat"], lng=d["lng"]),
                                     headers={"User-Agent": "4mi-polling-locator/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            g = json.load(r)["result"]["geographies"]
        place = (g.get("Incorporated Places") or g.get("Census Designated Places")
                 or g.get("County Subdivisions") or [{}])
        return key, tidy(place[0].get("NAME") or place[0].get("BASENAME") or "")
    except Exception:
        return key, None

done = 0
with cf.ThreadPoolExecutor(max_workers=12) as ex:
    for key, city in ex.map(lookup, todo):
        if city:
            cache[key] = city
        done += 1

json.dump(cache, open(CACHE, "w"), indent=0)

filled = 0
for d in payload["dorms"]:
    if not d.get("c"):
        c = cache.get(f"{d['lat']},{d['lng']}")
        if c:
            d["c"] = c
            d["cgeo"] = 1          # municipality derived from the verified geocode
            filled += 1

# refresh the per-school display city now that more are known
import collections
idx = collections.defaultdict(list)
for d in payload["dorms"]:
    idx[d["s"]].append(d)
for s in payload["schools"]:
    cities = collections.Counter(d["c"] for d in idx[s["k"]] if d.get("c"))
    if cities:
        s["city"] = cities.most_common(1)[0][0]

json.dump(payload, open(DATA, "w"), separators=(",", ":"))
still = sum(1 for d in payload["dorms"] if not d.get("c"))
print(f"filled this run: {filled}   cache size: {len(cache)}   still missing: {still}")
