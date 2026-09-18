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

Coverage as built: 29 campuses, 736 buildings, 149 precincts, and a named,
geocoded polling place for 736 of 736 buildings.

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

## Rebuilding the data

    npm run data     # build, fill municipalities, validate
    npm test         # 45 checks, no network needed

`build/build_data.py` joins the upstream file to the turf tracker.
`build/fill_city.py` reverse geocodes the buildings whose municipality the turf
record never carried, against the US Census geocoder, and caches the answers in
`build/city_cache.json` so the step is not repeated. `build/validate.py` runs
the point in polygon second opinion and writes the disagreement report.

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
    styles.css                        field suite dark glass
    data/dorms.json                   campuses, buildings, precincts, polls
    data/precincts-geo.json           149 polygons, lazy loaded for typed addresses
    build/                            the data pipeline and its cache
    tests/smoke.mjs                   45 checks including house style and privacy
