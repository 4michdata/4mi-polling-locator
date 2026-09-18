#!/usr/bin/env python3
"""
Build data/early-voting.json from the EV tab of 4MI_Turf_Precinct_Crosswalk_Validation.

The sheet was typed by hand, one row per precinct, and the multi site jurisdictions
were each typed in a different shape. This script reads the shapes it has actually
seen, refuses anything it cannot pair name for name with address, and writes those
precincts to _held so they stay off the page until a person fixes the sheet.

Inputs : ev_tab.json  (the tab, exported row by row)   dorms.json (the 149 precincts)
Output : early-voting.json
"""
import json, re, sys, collections

recs = json.load(open(sys.argv[1]))
OVERRIDES = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else {}
d    = json.load(open(sys.argv[2]))
prec = d['precincts']

def norm_id(s): s = re.sub(r'\D', '', s or ''); return s.zfill(13) if s else ''
def sq(s): return re.sub(r'\s+', ' ', (s or '')).strip()
def clean(s):
    s = re.sub(r'\s*[‐-―−]\s*', ' to ', s or '')
    s = re.sub(r'(\w+ \d{1,2}(?:st|nd|rd|th)?)\s*-\s*(\w+ \d{1,2})', r'\1 to \2', s)
    s = re.sub(r'(\d{1,2})\s*-\s*(\d{1,2})', r'\1 to \2', s)
    s = re.sub(r'\ba\.m\.', 'am', s); s = re.sub(r'\bp\.?\.?m\.', 'pm', s); s = re.sub(r'p\.\.m\.', 'pm', s)
    s = re.sub(r'(\d)(am|pm)\b', r'\1 \2', s)
    s = re.sub(r'(\d):00 ?(am|pm)', r'\1 \2', s)
    return sq(s)

STREET = r'(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Lane|Ln|Way|Court|Ct|Hwy|Highway|Trail|Trl|Pkwy|Parkway|Circle|Cir|Place|Pl|Square|Sq|Lyndon|Conner)'
# an address ends at a Michigan ZIP, 5 digits, or 4 when the sheet truncated it at the cell edge
ADDR = re.compile(r'\d{2,5}[A-Za-z]? [A-Z0-9][A-Za-z0-9\.\'&# ]*?,? ?(?:Ste\.? \d+,? )?[A-Za-z\. ]+?,? (?:MI|Michigan),? \d{4,5}')

def zip_fix(a):
    # 4 digit ZIP at the end of a cell is a truncation; Portage is 49002
    return re.sub(r'(, MI )(\d{4})$', lambda m: m.group(1) + m.group(2) + ('2' if m.group(2) == '4900' else ''), a)

def hours_by_site(hcell, names):
    """'UMMA: 11 am to 7 pm Duderstadt: 11 am to 7 pm ...' -> one per site, matched by first word."""
    parts = re.split(r'(?<=[a-z\.]) (?=[A-Z][A-Za-z ]{2,20}:)', hcell)
    got = {}
    for p in parts:
        m = re.match(r'([A-Z][A-Za-z ]{2,20}):\s*(.+)$', p.strip())
        if m: got[m.group(1).strip().lower()] = clean(m.group(2))
    if not got: return [clean(hcell)] * len(names)
    out = []
    for n in names:
        key = next((k for k in got if k.split()[0] in n.lower() or n.lower().split()[0] in k), None)
        out.append(got[key] if key else clean(hcell))
    return out

def parse(r):
    name, addr, hours, dates = sq(r['ev_name']), sq(r['ev_addr']), sq(r['ev_hours']), sq(r['ev_dates'])
    addrs = [zip_fix(a.strip().rstrip(',')) for a in ADDR.findall(addr)]

    # Shape A: one site
    if len(addrs) <= 1:
        return [{"name": name, "addr": addr, "hours": clean(hours), "dates": clean(dates)}]

    # Shape B: the name cell repeats "Name, address" per site (Detroit). Split names on the addresses.
    if all(a.split(',')[0] in name for a in addrs):
        names = []
        rest = name
        for a in addrs:
            head = a.split(',')[0]
            i = rest.find(head)
            names.append(rest[:i].strip().rstrip(','))
            rest = rest[i + len(a):].strip()
        if all(names):
            return [{"name": names[i], "addr": addrs[i], "hours": clean(hours), "dates": clean(dates)} for i in range(len(addrs))]

    # Shape C: names run together in one cell. Cut on known site names first, then on site nouns.
    KNOWN = ['University of Michigan Museum of Art', 'Duderstadt Center', 'City Hall', 'Traverwood Library',
             'Malletts Creek Library', 'Westgate Library',
             'WKAR Studio A (Communication Arts and Sciences Building)', 'East Lansing Hannah Community Center',
             'Douglass Community Association', 'Kalamazoo County Expo Center', 'Fetzer Center at WMU',
             'Portage Parks & Recreation Department']
    names, rest = [], name
    progress = True
    while rest and progress:
        progress = False
        for k in KNOWN:
            if rest.startswith(k):
                names.append(k); rest = rest[len(k):].strip(); progress = True; break
    if rest or len(names) != len(addrs):
        NOUNS = {'Center','Hall','Library','Building','Association','Department','Church','School','Office','Studio',
                 'Annex','Complex','Arena','Station','Township','Centre','Museum','Club','House','Academy','Park',
                 'Commons','Gym','Auditorium','Chambers','Courthouse','Facility','Pavilion','Lodge','Union'}
        words = name.split(); out = []; cur = []
        for i, w in enumerate(words):
            cur.append(w)
            if w.strip('(),.') in NOUNS and len(out) < len(addrs) - 1 and i + 1 < len(words) \
               and words[i+1][:1].isupper() and words[i+1].lower() not in ('at','of','&','and'):
                out.append(' '.join(cur)); cur = []
        if cur: out.append(' '.join(cur))
        names = out
    if len(names) != len(addrs):
        return None
    hs = hours_by_site(hours, names)
    ds = hours_by_site(dates, names) if ':' in dates else [clean(dates)] * len(names)
    return [{"name": names[i], "addr": addrs[i], "hours": hs[i], "dates": ds[i]} for i in range(len(addrs))]

def satellite(r):
    sat, loc, hrs = sq(r['sat']), sq(r['sat_loc']), sq(r['sat_hours'])
    if not re.match(r'^\s*y', sat, re.I): return None
    # Ann Arbor typed the whole story into every satellite cell; keep it once, cleaned.
    where = loc if loc.lower() not in ('yes', 'y', '') else sat
    return {"where": clean(re.sub(r'^Yes:?\s*', '', where)), "hours": clean(hrs) if hrs != where else ''}

# ---- assemble
by_id = {}
for r in recs:
    c = norm_id(r['pid'])
    if c and re.search(r'^\s*yes', r['confirmed'], re.I): by_id.setdefault(c, r)
# Marquette 1: two confirmed rows, same library, one names the floor. Take the fuller one.
mq = [r for r in recs if norm_id(r['pid']) == '1035190000001']
if mq: by_id['1035190000001'] = max(mq, key=lambda r: len(r['ev_name']))

out = {"_readme": [
  "Early voting sites for the November 3, 2026 general election, keyed by 4MI precinct id.",
  "Source: 4MI_Turf_Precinct_Crosswalk_Validation_Draft2, EV tab, Clerk Confirmed = Yes rows only.",
  "Built by build/build_early.py. A precinct is written only when every site name pairs with an",
  "address; anything the script cannot pair goes to _held with the reason and stays off the page.",
  "Multi site cities (Ann Arbor, East Lansing, Kalamazoo, Detroit) were typed free form in the",
  "sheet; the parser knows those shapes. A new shape lands in _held, which is the correct outcome."],
  "window": {"start": "2026-10-24", "end": "2026-11-01"},
  "built": "2026-09-18", "precincts": {}, "_held": {}}

# conflicting rows for one precinct: hold unless the difference is only a floor or suite
groups = collections.defaultdict(list)
for r in recs:
    c = norm_id(r['pid'])
    if c and re.search(r'^\s*yes', r['confirmed'], re.I): groups[c].append(sq(r['ev_name']).lower())
for code in prec:
    r = by_id.get(code)
    if not r: continue
    names = set(groups.get(code, []))
    if len(names) > 1 and len({n.split(',')[0] for n in names}) > 1:
        out['_held'][code] = {"name": prec[code]['name'], "reason": "confirmed rows disagree: " + ' / '.join(sorted(names))[:160]}
        continue
    juris = prec[code]['name'].split(', Precinct')[0].split(', Ward')[0].strip()
    if juris in OVERRIDES:
        o = OVERRIDES[juris]
        out['precincts'][code] = {"sites": o['sites'], "satellite": o.get('satellite'),
                                  "confirmed": "2026-09-18", "by": "clerk, per crosswalk sheet, hand read"}
        continue
    sites = parse(r)
    if not sites:
        out['_held'][code] = {"name": prec[code]['name'], "reason": "could not pair site names with addresses: " + sq(r['ev_name'])[:120]}
        continue
    out['precincts'][code] = {"sites": sites, "satellite": satellite(r), "confirmed": "2026-09-18", "by": "clerk, per crosswalk sheet"}

json.dump(out, open(sys.argv[3], 'w'), indent=1)
cov = sum(1 for x in d['dorms'] if x['p'] in out['precincts'])
print(f"live precincts {len(out['precincts'])} of {len(prec)}   buildings covered {cov} of {len(d['dorms'])} ({cov/len(d['dorms'])*100:.0f}%)   held {len(out['_held'])}")
for k, v in out['_held'].items(): print('   held', k, v['name'], '|', v['reason'][:110])
multi = [(c, v) for c, v in out['precincts'].items() if len(v['sites']) > 1]
print(f"multi site precincts {len(multi)}; sites with a blank name: {sum(1 for c,v in out['precincts'].items() for s in v['sites'] if not s['name'])}")
