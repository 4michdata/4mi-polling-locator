#!/usr/bin/env python3
"""
Build data/early-voting.json from the EV tab of 4MI_Turf_Precinct_Crosswalk_Validation.

The sheet was typed by hand, one row per precinct, and the multi site jurisdictions
were each typed in a different shape. This script reads the shapes it has actually
seen, refuses anything it cannot pair name for name with address, and writes those
precincts to _held so they stay off the page until a person fixes the sheet.

Inputs : ev_tab.json  (the tab, exported row by row)   dorms.json (the 149 precincts)
         ev_overrides.json (hand read multi site cities)   ev_extra.json (optional, sites
         confirmed from the clerk's own published notice for jurisdictions the sheet lacks)
Output : early-voting.json

Early voting sites are designated per city or township and serve every voter of
that jurisdiction, so a precinct with no row of its own inherits the sites of its
jurisdiction when every confirmed row for that jurisdiction names the same
addresses. Rows that disagree hold the whole jurisdiction.
"""
import json, re, sys, collections, html

recs = json.load(open(sys.argv[1]))
OVERRIDES = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else {}
d    = json.load(open(sys.argv[2]))
prec = d['precincts']

def norm_id(s): s = re.sub(r'\D', '', s or ''); return s.zfill(13) if s else ''
def sq(s): return re.sub(r'\s+', ' ', html.unescape(s or '').replace('\r', ' ')).strip()
def clean(s):
    s = re.sub(r'\s*[‐-―−]\s*', ' to ', s or '')
    s = re.sub(r'(\w+ \d{1,2}(?:st|nd|rd|th)?)\s*-\s*(\w+ \d{1,2})', r'\1 to \2', s)
    s = re.sub(r'(\d{1,2})\s*-\s*(\d{1,2})', r'\1 to \2', s)
    s = re.sub(r'\ba\.m\.', 'am', s); s = re.sub(r'\bp\.?\.?m\.', 'pm', s); s = re.sub(r'p\.\.m\.', 'pm', s)
    s = re.sub(r'\b([ap])\.m\b\.?', r'\1m', s, flags=re.I)          # a.m / p.m with or without the last period
    s = re.sub(r'(\d):(\d\d):00\b', r'\1:\2', s)                       # 8:30:00 -> 8:30
    s = re.sub(r'(?<=[\d ])(AM|PM|Am|Pm)\b', lambda m: m.group(1).lower(), s)
    s = re.sub(r',? ?2026\b', '', s)                                       # the year adds nothing inside an hours cell
    s = s.replace('\\', '')
    s = re.sub(r'(\d)(am|pm)\b', r'\1 \2', s)
    s = re.sub(r'(\d):00 ?(am|pm)', r'\1 \2', s)
    s = re.sub(r'(am|pm)\s*-\s*(?=\d)', r'\1 to ', s)                    # 8 am - 4 pm -> 8 am to 4 pm
    s = re.sub(r'(\d)\s*-\s*(?=\d{1,2}(:\d\d)? ?(am|pm))', r'\1 to ', s)
    s = re.sub(r'(\d ?(?:am|pm)\.?)\s+(?=(?:Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|October|November|Oct|Nov)\b)', r'\1; ', s)
    s = re.sub(r'\s-\s', ' to ', s)                                        # a spaced hyphen between two days or dates
    return sq(s)

CITY_FIX = {'caledonia township': 'Caledonia, MI 49316', 'summit township': 'Jackson, MI 49203', 'livonia': 'Livonia, MI 48154'}

MONTHS = {'10': 'October', '11': 'November'}
def norm_dates(s):
    """'10/24-11/1', '10/24/11/1', 'Saturday, October 24 - Sunday, November 1', 'October 24 - November 1, 2026' -> 'October 24 to November 1'"""
    t = sq(s)
    m = re.search(r'\b(1[01])/(\d{1,2})\D+?(1[01])/(\d{1,2})\b', t)
    if m: return f"{MONTHS[m.group(1)]} {int(m.group(2))} to {MONTHS[m.group(3)]} {int(m.group(4))}"
    m = re.search(r'(October|November)\s+(\d{1,2})(?:st|nd|rd|th)?\D+?(October|November)\s+(\d{1,2})(?:st|nd|rd|th)?', t)
    if m: return f"{m.group(1)} {int(m.group(2))} to {m.group(3)} {int(m.group(4))}"
    return clean(t)

def tidy_site(x, j=None):
    name, addr = sq(x['name']), sq(x['addr']).replace('\\', '')
    # the name cell sometimes carries the address too (Houghton), and the address cell sometimes repeats the name (Big Rapids Twp)
    if addr and addr.lower() in name.lower():
        name = sq(name.lower().replace(addr.lower(), '')).strip(' ,')
        name = ' '.join(w if w.isupper() and len(w) > 3 else w.capitalize() for w in name.split()) if name.islower() else sq(x['name']).split(addr)[0].strip(' ,')
    if name and addr.lower().startswith(name.lower()):
        addr = addr[len(name):].strip(' ,')
    name = re.sub(r',?\s*\d{2,5} [A-Z][A-Za-z\.]* (?:Ave|Rd|St|Dr|Blvd)\.?.*$', '', name).strip(' ,') or name
    if not re.search(r'\b(MI|Michigan)\b', addr):
        addr = re.sub(r'\.?,?\s*\d{5}$', '', addr).rstrip('.') + ', ' + CITY_FIX.get(j or '', 'Michigan')
    if name.isupper(): name = ' '.join(w.capitalize() if len(w) > 2 else w for w in name.split())
    if addr.isupper(): addr = ' '.join(w if re.match(r'^(MI|[NSEW]{1,2}|\d+)$', w.strip(',.')) else (w.lower() if re.match(r'^\d+(ST|ND|RD|TH)$', w) else w.capitalize()) for w in addr.split())
    return {"name": name, "addr": addr, "hours": clean(x['hours']), "dates": norm_dates(x['dates'])}

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
             'Portage Parks & Recreation Department', 'Ypsilanti Township Civic Center', 'Ypsilanti Township Community Center']
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
EXTRA = json.load(open(sys.argv[5])) if len(sys.argv) > 5 else {}

def jname(n):
    """'City of Rochester Hills, District 4, Precinct 20' -> 'rochester hills'; 'City of Houghton Precinct 2' -> 'houghton'."""
    j = re.split(r',? (Precinct|Ward|District)\b', n or '')[0].strip().lower()
    j = re.sub(r'^city of ', '', j)
    j = re.sub(r'^charter township of (.+)$', r'\1 township', j)
    j = re.sub(r'\bcharter township\b', 'township', j)
    return re.sub(r'\s+', ' ', j)

def sig(sites):
    """address signature: street number plus the first street word, so a floor or a typo in the name is not a disagreement"""
    out = set()
    for x in sites:
        m = re.search(r'(\d{2,5})[A-Za-z]? +([A-Za-z]+)', x['addr'] or '')
        out.add((m.group(1) + ' ' + m.group(2).lower()) if m else sq(x['name']).lower())
    return frozenset(out)

confirmed = [r for r in recs if re.search(r'^\s*yes', r['confirmed'] or '', re.I)]
by_j = collections.defaultdict(list)
for r in confirmed: by_j[jname(r['pname'])].append(r)
own = collections.defaultdict(list)           # rows that carry a dorm precinct's own id
for r in confirmed:
    c = norm_id(r['pid'])
    if c in prec and jname(prec[c]['name']) == jname(r['pname']): own[c].append(r)

def display_name(code):
    return re.split(r', (Precinct|Ward|District)\b', prec[code]['name'])[0].strip()

canon, held_j, skipped = {}, {}, []
for key, o in OVERRIDES.items():
    if key.startswith('_'): continue
    canon[jname(key)] = {"sites": o['sites'], "satellite": o.get('satellite'), "rows": len(by_j.get(jname(key), [])), "how": "hand read",
                         "by": o.get('by'), "confirmed": o.get('confirmed', "2026-09-18")}
for j, rs in by_j.items():
    if j in canon: continue
    usable = [r for r in rs if re.search(r'\d', r['ev_addr'] or '')]
    for r in rs:
        if r not in usable: skipped.append((r['pname'], 'address cell holds no street number, columns shifted'))
    if not usable:
        held_j[j] = "no row carries a street address: " + sq(rs[0]['ev_name'])[:120]; continue
    parsed = [(r, parse(r)) for r in usable]
    good = [(r, ss) for r, ss in parsed if ss]
    if not good:
        held_j[j] = "could not pair site names with addresses: " + sq(usable[0]['ev_name'])[:120]; continue
    sigs = {sig(ss) for r, ss in good}
    if len(sigs) > 1:
        held_j[j] = "confirmed rows disagree: " + ' / '.join(sorted({sq(r['ev_addr']).lower()[:50] for r, ss in good}))[:160]; continue
    # the name most rows use wins; a tie goes to the fullest (Marquette names the floor on one of two rows)
    names = collections.Counter(sq(r['ev_name']) for r, ss in good)
    top = max(names.values())
    pick = max((r for r, ss in good if names[sq(r['ev_name'])] == top), key=lambda r: len(r['ev_name'] or ''))
    ss = next(ss for r, ss in good if r is pick)
    canon[j] = {"sites": [tidy_site(x, j) for x in ss], "satellite": satellite(pick), "rows": len(rs), "how": "parsed"}

for key, e in EXTRA.items():
    if key.startswith('_') or jname(key) in canon: continue
    canon[jname(key)] = {"sites": e['sites'], "satellite": e.get('satellite'), "rows": 0, "how": "clerk notice", "by": e['by'], "confirmed": e['confirmed']}

out = {"_readme": [
  "Early voting sites for the November 3, 2026 general election, keyed by 4MI precinct id.",
  "Source: 4MI_Turf_Precinct_Crosswalk_Validation_Draft2, EV tab, Clerk Confirmed = Yes rows only,",
  "plus build/ev_extra.json for jurisdictions the sheet lacks, each citing the clerk's own notice.",
  "Built by build/build_early.py. Sites are designated per city or township and serve every voter",
  "in it, so a precinct with no row inherits its jurisdiction's sites when every confirmed row for",
  "that jurisdiction names the same addresses (inherited: true, and by says from how many rows).",
  "Rows that disagree, or that cannot be paired name for name with an address, hold the whole",
  "jurisdiction in _held and stay off the page. A new sheet shape lands in _held, which is correct."],
  "window": {"start": "2026-10-24", "end": "2026-11-01"},
  "built": "2026-09-18", "precincts": {}, "_held": {},
  "_no_row_in_sheet": {"_readme": "dorm precincts whose jurisdiction has no confirmed row anywhere in the sheet", "precincts": {}}}

lived = {x['p'] for x in d['dorms']}          # precincts that actually carry a building; the rest only serve typed addresses
for code in prec:
    if code not in lived: continue
    j = jname(prec[code]['name'])
    if j in held_j:
        out['_held'][code] = {"name": prec[code]['name'], "reason": held_j[j]}; continue
    c = canon.get(j)
    if not c:
        out['_no_row_in_sheet']['precincts'][code] = prec[code]['name']; continue
    mine = own.get(code, [])
    entry = {"sites": c['sites'], "satellite": c['satellite'], "confirmed": c.get('confirmed', "2026-09-18")}
    if c['how'] == 'clerk notice' or c.get('by'):
        entry['by'] = c['by']
    elif mine:
        entry['by'] = "clerk, per crosswalk sheet" + (", hand read" if c['how'] == 'hand read' else "")
        if c['how'] == 'parsed':
            s_own = satellite(mine[0])
            if s_own: entry['satellite'] = s_own
    else:
        entry['by'] = f"clerk, per crosswalk sheet, inherited from {c['rows']} confirmed row{'s' if c['rows'] != 1 else ''} for {display_name(code)}"
        entry['inherited'] = True
    out['precincts'][code] = entry

json.dump(out, open(sys.argv[3], 'w'), indent=1)
cov = sum(1 for x in d['dorms'] if x['p'] in out['precincts'])
inh = sum(1 for v in out['precincts'].values() if v.get('inherited'))
print(f"live precincts {len(out['precincts'])} of {len(lived)} with buildings ({inh} inherited)   buildings covered {cov} of {len(d['dorms'])} ({cov/len(d['dorms'])*100:.0f}%)   held {len(out['_held'])}   no row {len(out['_no_row_in_sheet']['precincts'])}")
for k, v in out['_held'].items(): print('   held', k, v['name'], '|', v['reason'][:110])
for k, v in out['_no_row_in_sheet']['precincts'].items(): print('   no row', k, v)
for pn, why in skipped: print('   skipped row', pn, '|', why)
print(f"sites with a blank name or address: {sum(1 for v in out['precincts'].values() for s in v['sites'] if not s['name'] or not s['addr'])}")
if '--table' in sys.argv:
    for j in sorted(canon):
        c = canon[j]
        print(f"{j:28s} {c['how']:12s} rows {c['rows']:2d} | " + ' || '.join(f"{x['name']} @ {x['addr']} | {x['hours']} | {x['dates']}" for x in c['sites'])[:260])
