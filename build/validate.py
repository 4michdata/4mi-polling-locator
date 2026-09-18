#!/usr/bin/env python3
"""
Independent check on every building's precinct assignment.

The baked assignment is voter file sourced and stays authoritative. This script
re-derives the precinct a second way, by dropping the building's verified
lat/lng into the state published 2026 precinct polygons, and stamps any
building where the two methods disagree. The page then softens its wording on
those buildings instead of asserting a polling place it cannot corroborate.

Writes:
  data/dorms.json                 adds "chk": 1 (disagree) or 2 (outside all)
  build/precinct_disagreements.csv  the working list for the turf owner
"""
import json, os, csv

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")

data = json.load(open(os.path.join(DATA, "dorms.json")))
geo  = json.load(open(os.path.join(DATA, "precincts-geo.json")))

def in_ring(pt, ring):
    lat, lng = pt
    inside = False
    n = len(ring)
    for i in range(n):
        j = i - 1
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi:
            inside = not inside
    return inside

def in_feature(pt, g):
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    for p in polys:
        if p and in_ring(pt, p[0]) and not any(in_ring(pt, h) for h in p[1:]):
            return True
    return False

rows, agree, disagree, outside = [], 0, 0, 0
for d in data["dorms"]:
    pt = (d["lat"], d["lng"])
    hit = next((f for f in geo["features"] if in_feature(pt, f["geometry"])), None)
    d.pop("chk", None)
    if hit is None:
        outside += 1
        d["chk"] = 2
        rows.append([d["s"], d["n"], d.get("a", ""), d.get("c", ""), d.get("t", ""),
                     d["p"], "", "outside every student precinct",
                     "approx geocode" if d.get("approx") else ""])
    elif hit["properties"]["code"] != d["p"]:
        disagree += 1
        d["chk"] = 1
        rows.append([d["s"], d["n"], d.get("a", ""), d.get("c", ""), d.get("t", ""),
                     d["p"], hit["properties"]["code"], "polygon disagrees",
                     "approx geocode" if d.get("approx") else ""])
    else:
        agree += 1

data["meta"]["validation"] = {
    "method": "lat/lng point in the state published 2026 precinct polygons",
    "agree": agree, "disagree": disagree, "outside": outside,
    "rate": round(agree / len(data["dorms"]) * 100, 1),
}
json.dump(data, open(os.path.join(DATA, "dorms.json"), "w"), separators=(",", ":"))

with open(os.path.join(HERE, "precinct_disagreements.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["School", "Building", "Address", "City", "Turf Code",
                "Assigned Precinct", "Polygon Precinct", "Finding", "Note"])
    w.writerows(sorted(rows))

print(f"agree     {agree}")
print(f"disagree  {disagree}")
print(f"outside   {outside}")
print(f"rate      {data['meta']['validation']['rate']}%")
print(f"report    build/precinct_disagreements.csv  ({len(rows)} rows)")
