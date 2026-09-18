# For Michigan · Where I Vote

Public, student facing polling place locator, built to live on 4mich.org. A
student picks their campus and their building from two dropdowns, and the page
fills in the address and returns the polling place assigned to that building's
precinct, with a map, a walk estimate, directions and Street View.

Live: https://4mi-where-i-vote.netlify.app

No sign in, no voter PII, no backend. Static files served from Netlify.

## Brand

Every token in `styles.css` was read off 4mich.org itself: navy `#0B1F6B`, sky
`#4FC3F7` with black type on the primary button, red `#D13630` used sparingly,
Bebas Neue for headlines, Space Grotesk in uppercase for controls, square
corners, `#333` body text on white. The header carries the site's own crest
(`assets/fm-logo.png`, pulled from 4mich.org). It is not the field suite's dark
teal, on purpose: this is a public page on the organization's website.

Campus marks live in `assets/campus/`, normalized to 96x96. Twenty two came from
each institution's own site. Seven institutions block automated fetching or
serve only a 16 pixel icon (Aquinas, EMU, Kalamazoo College, Kettering, SVSU,
Detroit Mercy, UM Dearborn) and show a navy chip with their initials instead.
Drop a square PNG into `assets/campus/` named for the slug and add the slug to
`MARKS` in `app.js` to promote one. University marks are their institutions'
trademarks; their use here was a deliberate decision by the program.

## Where the answers come from

The chain is `building -> address -> precinct -> polling place`, and every link
was already in the suite before this page existed.

| Link | Source |
|---|---|
| Building and address | FM Master Turf Tracker, operational copy |
| Building coordinates | The geocode already validated in the turf precinct crosswalk |
| Precinct assignment | Voter file sourced, carried on the turf record |
| Polling place | State of Michigan published 2026 precinct layer |

`reporting-auth/public/votepro-geo.json` is the upstream file that already
carried all four. This page ships a public safe subset of it: the voter counts
that VotePro renders (`reg`, `active`, `youth`, `youth_pct`) are stripped at
build time, and the smoke test fails if they ever reappear.

Coverage as built: 29 campuses, 736 buildings, 151 precincts (the 149 student
housing precincts plus two that the building corrections below needed), and a
named, geocoded polling place for 736 of 736 buildings.

## Ten buildings the turf record had in the wrong place

Reading the early voting sheet against the turf record exposed five rows whose
precinct id and precinct name disagreed. Chasing them found ten buildings whose
turf geocode had landed miles from the building, consistently enough that the
point in polygon check could not catch it (a wrong pin inside the wrong precinct
still agrees with itself):

| Building | Turf record said | Actually |
|---|---|---|
| Landmark on Grand River (MSU) | Williamstown Township, 15 miles east | 205 E Grand River Ave, East Lansing, Precinct 6 |
| Great Oaks Apartments (OU) | Ortonville, 22 miles north | 940 Oakwood Dr, City of Rochester, Precinct 1 |
| Meadowbrooke Apartment Homes (Davenport) | Grand Rapids Charter Township | Cascade Charter Township, Precinct 5 (street misspelled) |
| Seven Aquinas halls with no street address | East Grand Rapids | Aquinas College campus, Grand Rapids Ward 2, Precinct 21 |

Each correction was triangulated three ways before it was written: a rooftop
geocode of the real address, that point dropped into the State of Michigan 2026
precinct layer, and the precinct the crosswalk sheet itself names. They live in
`build/building_fixes.json` with the evidence, `build/apply_fixes.py` applies
them after `build_data.py`, and the page discloses a corrected pin in its
provenance line. Every one of them is also a defect in the Master Turf Tracker;
`build/turf_record_corrections.csv` is the list for whoever owns it. Fix it
upstream and delete the entry.

## The second opinion

The precinct on the turf record is voter file sourced and stays authoritative.
The build independently re-derives it a second way, by dropping each building's
coordinates into the state precinct polygons, and compares:

- 687 agree
- 27 disagree, usually a building sitting on or near a precinct line
- 22 fall outside every student housing precinct we carry

Buildings in the second two groups are stamped `chk` in `dorms.json`, and the
page softens its wording on them and points the student at the state's own
lookup rather than asserting a polling place it cannot corroborate twice.
`build/precinct_disagreements.csv` is the working list for whoever owns the
turf record.

## Early voting

Michigan early voting sites are chosen by each city or township clerk, are
usually not the Election Day polling place, and the state publishes no bulk
list of them. The only official lookup is MVIC, which refuses automation. So
the page carries its own table, `data/early-voting.json`, keyed by precinct id
and built from the program's clerk confirmed crosswalk sheet
(`4MI_Turf_Precinct_Crosswalk_Validation_Draft2`, EV tab).

    npm run early    # build/build_early.py over the sheet extract, the overrides and the clerk notices

Rules the build enforces, and the page and tests re-enforce:

- only rows with Clerk Confirmed = Yes are read; everything else is ignored
- sites are designated per city or township and serve every voter in it, so
  rows are pooled by jurisdiction (the precinct NAME, since five sheet rows
  carry a precinct id that belongs to a different jurisdiction), and a precinct
  with no row of its own inherits its jurisdiction's sites when every confirmed
  row for that jurisdiction names the same addresses (`inherited: true`, and
  `by` says from how many rows)
- rows that disagree, or that cannot be paired name for name with an address,
  hold the whole jurisdiction in `_held` and stay off the page
- a row whose address cell holds no street number (columns shifted) is skipped
- multi site cities (Ann Arbor, East Lansing, Kalamazoo, Detroit, Grand Rapids,
  Midland, Lansing, Royal Oak, the Clinton County pair) were typed free form,
  and two address cells were dragged down so the street number auto
  incremented (Allendale 6676 to 6679, Auburn Hills 1899 to 1901; the first row
  is the real one, verified on the county and city sites). `build/ev_overrides.json`
  carries all of these hand read, and wins over the parser
- `build/ev_extra.json` fills jurisdictions the sheet has no row for from the
  clerk's own published notice, each entry citing it (Houghton County's
  countywide HoCo Arena site, from the City of Hancock election page)
- the page will not render a site without a `confirmed` date, and sorts
  on campus sites (`campus: true`) first

Coverage as built: 145 of the 147 precincts that carry a building, 734 of 736
buildings, 0 held. Still open: Peninsula Township (one NWMC building; the
township shares an East Bay Township site with four neighbours but has posted
only the August arrangement) and the City of Trenton (one WSU building; the
city site blocks automated reading). One row worth a phone call: the sheet's
City of Houghton row names First Apostolic Lutheran Church, while the City of
Hancock notice and two newspapers describe HoCo Arena in Hancock as the single
countywide site for November. The sheet row ships, as the program's own
confirmation, flagged in `build/ev_clerk_followup.csv`.

`build/ev_tab.json` is the sheet extract with the working notes column
removed. Refresh it from the sheet, rerun the build, rerun the tests.

## Rebuilding the data

    npm run data     # build, fill municipalities, apply building fixes, validate, early voting
    npm test         # 119 checks, no network needed

`build/build_data.py` joins the upstream file to the turf tracker.
`build/fill_city.py` reverse geocodes the buildings whose municipality the turf
record never carried, against the US Census geocoder, and caches the answers in
`build/city_cache.json` so the step is not repeated. `build/apply_fixes.py`
applies the building corrections. `build/validate.py` runs the point in
polygon second opinion and writes the disagreement report.

## Deliberate choices worth knowing before you change something

**The map is raster tiles on Leaflet, not vector tiles on Mapbox.** A student
opens this on whatever phone they have. Vector basemaps need WebGL, a style
document, a glyph server and an access token, and each one is a way to hand
somebody a blank square on the morning they need to vote. Three separate
attempts at the vector path failed here: the Fieldline Mapbox token is URL
restricted to `field-line.netlify.app` and returns 403 on every tile from any
other domain; the MapLibre fallback never finished loading its style; and
CARTO's free dark tiles now stamp API KEY REQUIRED across every tile. The
basemap is Esri's dark canvas, keyless and unwatermarked.

**No `requestAnimationFrame` anywhere in the map path.** rAF does not fire in a
tab the browser is not painting, so a student who switches apps for a moment
would come back to a map that never started. This cost an afternoon; do not
reintroduce it.

**No routing service.** The only keyless router available returns driving times
from its walking endpoint, which is how a one mile walk came back as four
minutes. The page shows a straight line distance and an approximate walk,
labelled as such, computed with a detour factor. The directions button hands
off to Google Maps, which does real pedestrian routing.

**The registration question is self declared.** MVIC returns 403 to anything
programmatic and michiganelections.io is dead, so there is no live authoritative
check to make. Answering no or not sure routes to the state's registration and
status pages. No student PII is collected or transmitted.

## Turning on the Google layer

`CONFIG.googleKey` in `app.js` is empty and the page runs fully keyless. Set it
to a Google Cloud key with Civic Information API and Geocoding API enabled, and
two things switch on with no other edits: Civic becomes an independent second
opinion printed beside our answer with an agreement badge, and Google Geocoding
replaces Nominatim for typed addresses. Restrict the key by HTTP referrer to
this domain before shipping it.

The Mapbox path can also be restored by adding `4mi-where-i-vote.netlify.app`
to that token's URL restrictions, though the raster map is the better default
for this audience.

## Files

    index.html                        the page
    app.js                            all behaviour
    styles.css                        4mich.org brand tokens
    data/dorms.json                   campuses, buildings, precincts, polls
    data/precincts-geo.json           151 polygons, lazy loaded for typed addresses
    data/guide.json                   student voting guide copy and the four dates
    data/early-voting.json            clerk confirmed early voting sites by precinct
    build/                            the data pipeline, the early voting build and caches
    tests/smoke.mjs                   119 checks including house style and privacy
