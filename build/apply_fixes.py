#!/usr/bin/env python3
"""
Apply build/building_fixes.json to data/dorms.json and data/precincts-geo.json.

Runs after build_data.py, fill_city.py and validate.py, so a full rebuild from the
upstream file re-applies every fix. Idempotent: applying twice changes nothing.
A fix is matched on building index AND name, so a reordered upstream file fails
loudly instead of patching the wrong building.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
fixes = json.load(open(os.path.join(HERE, 'building_fixes.json')))
d     = json.load(open(os.path.join(DATA, 'dorms.json')))
geo   = json.load(open(os.path.join(DATA, 'precincts-geo.json')))
added = json.load(open(os.path.join(HERE, 'state_precincts_added.geojson')))

# precincts the 149 did not carry
for code, p in fixes['precincts'].items():
    if code not in d['precincts']:
        d['precincts'][code] = {"name": p['name'], "county": p['county'], "poll": p['poll']}
have = {f['properties']['code'] for f in geo['features']}
for f in added['features']:
    code = f['properties']['PRECINCTCODE']
    if code not in have:
        geo['features'].append({"type": "Feature", "properties": {"code": code}, "geometry": f['geometry']})
        have.add(code)

by_i = {x['i']: x for x in d['dorms']}
changed = 0
for fx in fixes['fixes']:
    x = by_i.get(fx['i'])
    if not x or x['n'] != fx['n'] or x['s'] != fx['school']:
        sys.exit(f"fix for {fx['n']} (i={fx['i']}) does not match the building at that index; upstream order changed, re-key the fix")
    if x['p'] not in d['precincts'] or fx['set']['p'] not in d['precincts']:
        sys.exit(f"precinct missing for {fx['n']}")
    before = dict(x)
    x.update(fx['set'])
    x.pop('chk', None)            # the point now sits inside its precinct polygon by construction
    x['fix'] = 1                  # the page can say the pin was corrected by hand
    if x != before: changed += 1

d['meta']['counts']['precincts'] = len(d['precincts'])
d['meta']['fixes'] = len(fixes['fixes'])
json.dump(d, open(os.path.join(DATA, 'dorms.json'), 'w'), separators=(',', ':'))
json.dump(geo, open(os.path.join(DATA, 'precincts-geo.json'), 'w'), separators=(',', ':'))
print(f"fixes applied {changed} of {len(fixes['fixes'])}   precincts now {len(d['precincts'])}   polygons {len(geo['features'])}")
