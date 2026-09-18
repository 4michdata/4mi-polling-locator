/* =============================================================================
   4 Michigan · Polling Locator
   Public, no sign in, no voter PII. Everything a student sees is resolved from
   two baked files: data/dorms.json (schools, buildings, precincts, polls) and
   data/precincts-geo.json (polygons, lazy loaded only for a typed address).

   Verification layers, in order of authority:
     1. Baked   state published 2026 precinct layer, joined to the turf record
     2. Civic   Google Civic Information API, when CONFIG.civicKey is set
     3. Human   the MVIC link in the footer, which is always shown
   ========================================================================== */

'use strict';

const CONFIG = {
  /* Basemap: Esri's dark canvas, keyless and unwatermarked. Raster and Leaflet
     on purpose. A student opens this on whatever phone they have, so the map
     must not depend on WebGL, a style document, a glyph server or an access
     token, each of which is one more way to hand someone a blank square on the
     morning they need to vote. CARTO's dark tiles were the first choice and
     were dropped: they now stamp API KEY REQUIRED across every tile. */
  tileUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  labelUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  tileAttribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',

  /* Straight line understates a real walk. Campus paths wander, so multiply by
     a detour factor before converting to minutes, and label the number approx.
     We do not call a routing service: the only keyless one available returns
     driving times from its foot endpoint, and a wrong number on this page is
     worse than an honest estimate. The directions button hands off to Google
     Maps, which does real pedestrian routing. */
  detourFactor: 1.3,
  walkSpeed: 1.35,

  /* Google Cloud API key, deliberately empty. Tested against a real key on
     2026-09-18 and neither half of the Google plan pays off yet:

       Civic Information API  works, and knows our election (2026 General
                              Midterm, id 12000, 2026-11-03), but returns ZERO
                              polling locations nationwide. Not a Michigan gap:
                              Washington DC and Boston return "No information
                              for this address" too. States publish Voting
                              Information Project location data close to the
                              election, so re-test in October.

       Geocoding API          refuses referrer restricted keys outright, by
                              design: "API keys with referer restrictions
                              cannot be used with this API." It is a server
                              side product. Using Google geocoding from a
                              browser means the Maps JavaScript API Geocoder
                              and its SDK, and the only way to make this web
                              service accept a key is to leave that key
                              unrestricted, which is not an option on a page
                              whose source anyone can read.

     So the page stays keyless. Set googleKey once Civic carries Michigan
     data and the Civic cross check switches on by itself. */
  googleKey: '',

  /* Which election Civic should be asked about. Passing electionId=0 returns
     "Election unknown"; the id has to be real. Resolved at call time by
     matching electionDay, so this keeps working next cycle. */
  civicElectionId: null,

  /* Where an unregistered student is sent. */
  registerUrl: 'https://mvic.sos.state.mi.us/RegisterVoter',
  statusUrl:   'https://mvic.sos.state.mi.us/Voter/Index'
};

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const state = {
  data: null,        // dorms.json
  geo: null,         // precincts-geo.json, lazy
  registered: null,  // 'yes' | 'no' | 'unsure'
  school: null,
  origin: null,      // { name, addr, lat, lng, precinct, approx }
  map: null
};

/* ---------------------------------------------------------------- utilities */

const TITLE_SKIP = new Set(['of','the','at','on','and','a','an','for','in','to']);

/* The state layer writes some records in block capitals and others in mixed
   case, so 73 of the 149 polling addresses arrive already cased. Expansion and
   casing are therefore separate steps: everything gets expanded, only shouting
   gets re-cased. Doing both in one pass is what produced "Bogue Street" on one
   screen and "University Ave" on the next. */
const EXPAND = [
  [/\bSchl\b/gi, 'School'],   [/\bBldg\b/gi, 'Building'], [/\bElem\b/gi, 'Elementary'],
  [/\bCtr\b/gi, 'Center'],    [/\bChr?\b/gi, 'Church'],    [/\bTwp\b/gi, 'Township'],
  [/\bHs\b/gi, 'High School'],[/\bJr\b/gi, 'Junior'],      [/\bSr\b/gi, 'Senior'],
  [/\bLib\b/gi, 'Library'],   [/\bCo\b/gi, 'County'],      [/\bMem\b/gi, 'Memorial'],
  [/\bRd\b/gi, 'Road'],       [/\bSt\b/gi, 'Street'],      [/\bAve\b/gi, 'Avenue'],
  [/\bDr\b/gi, 'Drive'],      [/\bBlvd\b/gi, 'Boulevard'], [/\bLn\b/gi, 'Lane'],
  [/\bPkwy\b/gi, 'Parkway'],  [/\bCt\b/gi, 'Court'],       [/\bHwy\b/gi, 'Highway'],
  [/\bCir\b/gi, 'Circle'],    [/\bPl\b/gi, 'Place'],       [/\bTer\b/gi, 'Terrace'],
  [/\bTrl\b/gi, 'Trail'],     [/\bSta\b/gi, 'Station'],    [/\bAcad\b/gi, 'Academy'],
];

function expand(s) {
  /* St is Saint at the front of a name (ST PAUL LUTHERAN) and Street anywhere
     else (49 ABBOT ST). Resolve that before the generic table runs, or half
     the churches in the state end up on Street Paul. */
  let out = String(s || '').replace(/^St\.?\s+(?=[A-Za-z])/i, 'Saint ');
  for (const [re, to] of EXPAND) out = out.replace(re, to);
  return out;
}

function titleCase(s) {
  if (!s) return '';
  const shouting = s === s.toUpperCase();
  const cased = shouting
    ? String(s).toLowerCase().replace(/\b[a-z]/g, m => m.toUpperCase())
        .split(' ')
        .map((w, i) => (i > 0 && TITLE_SKIP.has(w.toLowerCase()) ? w.toLowerCase() : w))
        .join(' ')
    : String(s);
  /* Re-capitalise the quadrant suffixes that title casing flattens, so a
     Grand Rapids address reads 940 Baldwin Street SE, not Se. */
  return expand(cased).replace(/\b(ne|nw|se|sw)\b/gi, m => m.toUpperCase())
    .replace(/\s+/g, ' ').trim();
}

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDistance(m) {
  const mi = m / 1609.34;
  if (mi < 0.1) return Math.round(m / 0.3048) + ' ft';
  return mi.toFixed(mi < 10 ? 1 : 0) + ' mi';
}

function walkMinutes(m) {
  return Math.max(1, Math.round(m * CONFIG.detourFactor / CONFIG.walkSpeed / 60));
}

function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) -
            Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/* Ray casting, used only for a typed address. Handles Polygon and MultiPolygon. */
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt.lat) !== (yj > pt.lat) &&
        pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInFeature(pt, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (!poly.length || !pointInRing(pt, poly[0])) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (pointInRing(pt, poly[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

function scene(name) {
  $$('section.scene').forEach(s => s.classList.add('hide'));
  const el = $('#scene-' + name);
  if (el) {
    el.classList.remove('hide');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try { history.replaceState(null, '', '#' + name); } catch (e) {}
}

function renderSteps(active) {
  const labels = ['Campus', 'Building', 'Polling place'];
  const html = labels.map((l, i) => {
    const cls = i === active ? 'on' : (i < active ? 'done' : '');
    return `<span class="step ${cls}"><i>${i < active ? '&#10003;' : i + 1}</i>${l}</span>` +
           (i < labels.length - 1 ? '<s></s>' : '');
  }).join('');
  ['#steps', '#steps2'].forEach(id => { const n = $(id); if (n) n.innerHTML = html; });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  const res = await fetch('data/dorms.json');
  state.data = await res.json();
  const d = state.data;

  $('#statSchools').textContent = d.meta.counts.schools;
  $('#statDorms').textContent   = d.meta.counts.dorms;
  $('#statPolls').textContent   = d.meta.counts.precincts;
  $('#regStart').href = CONFIG.registerUrl;
  $('#regCheck').href = CONFIG.statusUrl;
  $('#footStamp').textContent = ' Data built ' + d.meta.built + '.';

  const ed = new Date(d.meta.election.date + 'T12:00:00');
  $('#electionPill').textContent = ed.toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric' });

  buildAbbrevs();
  buildSchools();

  $$('[data-reg]').forEach(b => b.addEventListener('click', () => {
    state.registered = b.dataset.reg;
    if (b.dataset.reg === 'yes') { renderSteps(0); scene('locate'); }
    else {
      const unsure = b.dataset.reg === 'unsure';
      $('#regTitle').textContent = unsure
        ? 'Let us check that first.'
        : 'Let us get you registered first.';
      $('#regSub').textContent = unsure
        ? 'The state keeps the official record. Check your status there, and if you are not on it yet you can register at your campus address in a few minutes.'
        : 'Registering at your campus address takes a few minutes. Once you are on the roll, come back here and we will show you where to vote.';
      scene('register');
    }
  }));

  $$('[data-go]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.go;
    if (t === 'locate') renderSteps(0);
    scene(t);
  }));

  $('#schoolSearch').addEventListener('input', buildSchools);
  $('#dormSearch').addEventListener('input', buildDorms);
  $('#addrGo').addEventListener('click', lookupAddress);
  $('#addrInput').addEventListener('keydown', e => { if (e.key === 'Enter') lookupAddress(); });
  $('#fromChange').addEventListener('click', () => { renderSteps(0); scene('locate'); });
  $('#btnShare').addEventListener('click', share);
}

/* --------------------------------------------------------------- campuses */

const TILE = ['linear-gradient(135deg,#2DD4BF,#5B9BFF)', 'linear-gradient(135deg,#5B9BFF,#A78BFA)',
              'linear-gradient(135deg,#A78BFA,#2DD4BF)', 'linear-gradient(135deg,#34D399,#5B9BFF)',
              'linear-gradient(135deg,#FBBF24,#2DD4BF)', 'linear-gradient(135deg,#5B9BFF,#34D399)'];

/* Campus tiles use the abbreviation the campus already goes by in the turf
   record, then a dedupe pass so no two tiles read the same. Three colleges
   would otherwise all render AC. */
let ABBR = null;
function buildAbbrevs() {
  ABBR = {}; const used = new Set();
  for (const s of state.data.schools) {
    let cand;
    if (/\s/.test(s.k)) {
      const parts = s.k.split(/\s+/).map(x => x.replace(/[^A-Za-z]/g, '')).filter(Boolean);
      const head = /^UofM$/i.test(parts[0]) ? 'UM' : parts[0].slice(0, 1);
      cand = (head + parts.slice(1).map(x => (/^[A-Z]+$/.test(x) ? x.slice(0, 2) : x.slice(0, 1))).join(''))
             .toUpperCase().slice(0, 4);
    } else {
      const k = s.k.replace(/[^A-Za-z]/g, '').toUpperCase();
      cand = k.length <= 5 ? k : k.slice(0, 4);
    }
    const seed = s.k.replace(/[^A-Za-z]/g, '').toUpperCase();
    let out = cand, n = cand.length;
    while (used.has(out) && n < seed.length) out = seed.slice(0, ++n);
    let bump = 2;
    while (used.has(out)) out = cand + (bump++);
    used.add(out); ABBR[s.k] = out;
  }
}
function initials(school) { return (ABBR && ABBR[school.k]) || school.k.slice(0, 4).toUpperCase(); }

function buildSchools() {
  const q = ($('#schoolSearch').value || '').trim().toLowerCase();
  const list = state.data.schools.filter(s =>
    !q || s.n.toLowerCase().includes(q) || s.k.toLowerCase().includes(q) ||
    (s.city || '').toLowerCase().includes(q));
  const grid = $('#schoolGrid');
  if (!list.length) { grid.innerHTML = '<div class="empty">No campus matches that.</div>'; return; }
  grid.innerHTML = list.map((s, i) => `
    <button class="school" data-k="${s.k}">
      <span class="tile" style="background:${TILE[i % TILE.length]}">${initials(s)}</span>
      <b>${s.n}</b>
      <em>${s.city} · ${s.count} building${s.count === 1 ? '' : 's'}</em>
    </button>`).join('');
  $$('.school', grid).forEach(b => b.addEventListener('click', () => pickSchool(b.dataset.k)));
}

function pickSchool(key) {
  state.school = state.data.schools.find(s => s.k === key);
  $('#dormTitle').textContent = 'Which building at ' + state.school.n + '?';
  $('#dormSub').textContent =
    'Find your residence hall or apartment. Your address fills in automatically, and we resolve the polling place from it.';
  $('#dormSearch').value = '';
  buildDorms();
  renderSteps(1);
  scene('dorm');
  setTimeout(() => $('#dormSearch').focus({ preventScroll: true }), 260);
}

function buildDorms() {
  const q = ($('#dormSearch').value || '').trim().toLowerCase();
  const all = state.data.dorms.filter(d => d.s === state.school.k);
  const list = all.filter(d => !q || d.n.toLowerCase().includes(q) ||
                               (d.a || '').toLowerCase().includes(q));
  list.sort((a, b) => a.n.localeCompare(b.n));
  const box = $('#dormList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">Nothing matches that. Try part of the name, or type your address instead.</div>';
    return;
  }
  box.innerHTML = list.map(d => `
    <button class="row" data-i="${d.i}">
      <span><b>${d.n}</b><em>${[d.a, d.c].filter(Boolean).join(', ') || 'Address on file'}</em></span>
      ${d.on ? '<span class="tag on">On campus</span>' : '<span class="tag">Off campus</span>'}
    </button>`).join('');
  $$('.row', box).forEach(b => b.addEventListener('click', () => {
    const d = state.data.dorms.find(x => x.i === +b.dataset.i);
    state.origin = {
      name: d.n,
      addr: [d.a, d.c, d.z && 'MI ' + d.z].filter(Boolean).join(', ') || d.c,
      lat: d.lat, lng: d.lng, precinct: d.p, approx: !!d.approx, chk: d.chk || 0, dorm: true
    };
    showResult();
  }));
}

/* ------------------------------------------------------- typed address */

async function geocode(q) {
  if (CONFIG.googleKey) {
    const u = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
              encodeURIComponent(q + ', Michigan') + '&key=' + CONFIG.googleKey;
    const r = await (await fetch(u)).json();
    if (r.status === 'OK' && r.results[0]) {
      const l = r.results[0].geometry.location;
      return { lat: l.lat, lng: l.lng, label: r.results[0].formatted_address };
    }
    return null;
  }
  /* Nominatim refuses a free text q alongside structured parameters such as
     state, so Michigan is appended to the query text instead. It also rate
     limits to roughly one call a second and can answer with something that is
     not JSON, which is why every step here is guarded and a failure simply
     sends the student to the state's own lookup. */
  const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us' +
            '&addressdetails=1&q=' +
            encodeURIComponent(q.replace(/,?\s*(MI|Michigan)\s*$/i, '') + ', Michigan');
  const res = await fetch(u, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  let r; try { r = await res.json(); } catch (e) { return null; }
  if (!Array.isArray(r) || !r.length) return null;
  return { lat: +r[0].lat, lng: +r[0].lon, label: tidyAddress(r[0]) };
}

/* Nominatim hands back a long display_name that leads with whatever business
   happens to sit at the address and trails through county and country. Rebuild
   it as the street line a person would write on an envelope. */
function tidyAddress(hit) {
  const a = hit.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const town = a.city || a.town || a.village || a.hamlet || a.township || a.county || '';
  const line = [street, town, ['MI', a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (street && town) return line;
  return String(hit.display_name || '')
    .replace(/,\s*United States$/, '')
    .split(',').slice(0, 4).join(',').trim();
}

async function lookupAddress() {
  const q = $('#addrInput').value.trim();
  const msg = $('#addrMsg');
  if (q.length < 6) {
    msg.innerHTML = '<div class="note"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/></svg><div>Add a little more, a street number and a city works best.</div></div>';
    return;
  }
  msg.innerHTML = '<div class="note" style="background:rgba(91,155,255,.08);border-color:rgba(91,155,255,.22);color:var(--mut)"><div>Looking that up.</div></div>';

  let hit = null;
  try { hit = await geocode(q); } catch (e) { hit = null; }
  if (!hit) {
    msg.innerHTML = note('We could not place that address just now. Check the street number and city, ' +
      'or look it up directly at the ' +
      '<a href="' + CONFIG.statusUrl + '" target="_blank" rel="noopener">Michigan Voter Information Center</a>, ' +
      'which is the state\u2019s own record.');
    return;
  }

  if (!state.geo) {
    try { state.geo = await (await fetch('data/precincts-geo.json')).json(); }
    catch (e) { state.geo = { features: [] }; }
  }
  const pt = { lat: hit.lat, lng: hit.lng };
  const f = state.geo.features.find(ft => pointInFeature(pt, ft.geometry));

  if (!f) {
    msg.innerHTML = note('That address sits outside the precincts we carry. We keep the ' +
      state.data.meta.counts.precincts + ' precincts that cover student housing across our ' +
      state.data.meta.counts.schools + ' campuses. For anywhere else in Michigan, the state has you covered at the ' +
      '<a href="' + CONFIG.statusUrl + '" target="_blank" rel="noopener">Michigan Voter Information Center</a>.');
    return;
  }
  msg.innerHTML = '';
  state.origin = {
    name: q, addr: hit.label.replace(/, United States$/, ''),
    lat: pt.lat, lng: pt.lng, precinct: f.properties.code, approx: false, dorm: false
  };
  showResult();
}

function note(html) {
  return '<div class="note"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg><div>' + html + '</div></div>';
}

/* ------------------------------------------------------------------ result */

function showResult() {
  const o = state.origin;
  const p = state.data.precincts[o.precinct];
  if (!p) { alert('We do not have a polling place for that precinct yet.'); return; }
  const poll = p.poll;
  const pollPt = { lat: poll.lat, lng: poll.lng };
  const dist = (poll.lat && o.lat) ? haversine(o, pollPt) : null;

  $('#fromName').textContent = o.dorm ? o.name : 'Your address';
  $('#fromAddr').textContent = o.addr;

  $('#pollName').textContent = titleCase(poll.name);
  /* A handful of state records carry the city, and one carries the state and
     ZIP, inside the street field. Only append the city when it is not already
     sitting there. */
  const pAddr = titleCase(poll.addr).replace(/\s+MI\s+\d{5}(-\d{4})?$/i, '');
  const pCity = titleCase(poll.city || '');
  $('#pollAddr').textContent =
    (pCity && !new RegExp('\\b' + pCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(pAddr))
      ? pAddr + ', ' + pCity : pAddr;
  $('#pollSub').textContent  = p.name + (p.county ? ' · ' + p.county + ' County' : '');

  const facts = [];
  if (dist != null) {
    facts.push(['Straight line', fmtDistance(dist), true]);
    facts.push(['On foot, approx', walkMinutes(dist) + ' min', false]);
  }
  facts.push(['Polls open', '7 am to 8 pm', false]);
  facts.push(['Precinct', p.name.replace(/^.*Precinct\s*/i, 'No. ') || 'On file', false]);
  $('#facts').innerHTML = facts.map(f =>
    `<div class="fact"><span>${f[0]}</span><b class="${f[2] ? 't' : ''}">${f[1]}</b></div>`).join('');

  const head = poll.lat ? Math.round(bearing(o, pollPt)) : 0;
  $('#btnDir').href = 'https://www.google.com/maps/dir/?api=1' +
    '&origin=' + o.lat + ',' + o.lng +
    '&destination=' + encodeURIComponent(poll.addr + ', ' + poll.city + ', MI') +
    '&travelmode=walking';
  $('#btnPano').href = 'https://www.google.com/maps/@?api=1&map_action=pano' +
    '&viewpoint=' + poll.lat + ',' + poll.lng + '&heading=' + head + '&pitch=0&fov=80';

  /* Confidence. The baked assignment is voter file sourced and stays the answer,
     but where an independent point in polygon check disagrees we say so rather
     than assert a polling place we cannot corroborate twice. */
  const apx = $('#approxNote');
  const says = [];
  if (o.chk === 1) says.push(
    'Two independent sources disagree about which precinct this building sits in, ' +
    'usually because the building straddles a precinct line. Confirm with your clerk ' +
    'or on the state site before you go.');
  else if (o.chk === 2) says.push(
    'This building sits on the edge of the precincts we carry, so treat the polling ' +
    'place below as a starting point and confirm it on the state site.');
  if (o.approx) says.push(
    'The pin for your building is approximate, so the walking distance is a close ' +
    'estimate. The polling place itself is exact.');
  if (says.length) {
    apx.style.display = '';
    $('#approxText').innerHTML = says.join(' ') +
      ' <a href="' + CONFIG.statusUrl + '" target="_blank" rel="noopener">Check on the state site</a>.';
  } else { apx.style.display = 'none'; }

  $('#prov').innerHTML =
    '<svg class="chk" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>' +
    '<div><b>How we know this.</b> Your building address comes from the 4 Michigan turf record. ' +
    'The precinct and its polling place come from the State of Michigan published 2026 precinct layer, ' +
    'snapshot <code>' + (state.data.meta.snapshot || state.data.meta.built) + '</code>. ' +
    'Precinct code <code>' + o.precinct + '</code>.' +
    (o.chk ? '' : ' Independently re-checked by dropping this building\u2019s coordinates into the state precinct polygons.') +
    (CONFIG.googleKey ? ' <span id="civicLine"></span>' : '') +
    '</div>';

  renderSteps(2);
  scene('result');
  drawMap(o, pollPt, poll).catch(() => {
    $('#mapNote').textContent = 'Map could not load, the links below still work';
  });
  if (CONFIG.googleKey) civicCrossCheck(o, poll);
}

/* -------------------------------------------------------------------- map */

/* -------------------------------------------------------------------- map */

async function drawMap(origin, pollPt, poll) {
  const node = $('#map');
  if (!poll.lat) { $('#mapNote').textContent = 'No map pin for this polling place yet'; return; }
  if (state.map) { try { state.map.remove(); } catch (e) {} state.map = null; }
  node.innerHTML = '';
  if (typeof L === 'undefined') { $('#mapNote').textContent = 'Map unavailable, the links below still work'; return; }

  /* Deliberately no requestAnimationFrame here. rAF does not fire in a tab the
     browser is not painting, so a student who switches apps for a moment would
     come back to a map that never started. A macrotask is enough to let the
     scene lay out, and invalidateSize below covers any late measurement. */
  await new Promise(r => setTimeout(r, 0));

  const from = [origin.lat, origin.lng], to = [pollPt.lat, pollPt.lng];
  const map = L.map(node, {
    zoomControl: true, attributionControl: true,
    scrollWheelZoom: false, dragging: true, tap: true
  }).setView([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], 15);
  state.map = map;

  L.tileLayer(CONFIG.tileUrl, { attribution: CONFIG.tileAttribution, maxZoom: 19 }).addTo(map);
  L.tileLayer(CONFIG.labelUrl, { maxZoom: 19, opacity: .85 }).addTo(map);

  const pin = cls => L.divIcon({ className: '', html: '<span class="pin ' + cls + '"></span>',
                                 iconSize: [16, 16], iconAnchor: [8, 8] });
  L.marker(from, { icon: pin('from'), keyboard: false })
    .bindPopup('<b>' + (origin.dorm ? origin.name : 'You') + '</b><br>' + origin.addr).addTo(map);
  L.marker(to, { icon: pin('to'), keyboard: false })
    .bindPopup('<b>' + titleCase(poll.name) + '</b><br>' + titleCase(poll.addr)).addTo(map);

  L.polyline([from, to], { color: '#2DD4BF', weight: 11, opacity: .15 }).addTo(map);
  L.polyline([from, to], { color: '#5B9BFF', weight: 3.4, opacity: .95,
                           dashArray: '7 7', lineCap: 'round' }).addTo(map);
  map.fitBounds(L.latLngBounds([from, to]), { padding: [46, 46], maxZoom: 17 });
  $('#mapNote').textContent = 'Straight line to your polling place';

  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 300);
}

function factCell(label) {
  return $$('#facts .fact').find(f => $('span', f).textContent === label);
}
function setFact(label, value) { const c = factCell(label); if (c) $('b', c).textContent = value; }
function setFactLabel(label, next) { const c = factCell(label); if (c) $('span', c).textContent = next; }

/* ------------------------------------------- Civic API, only when keyed */

async function civicCrossCheck(origin, poll) {
  const line = $('#civicLine');
  if (!line) return;
  try {
    if (CONFIG.civicElectionId == null) {
      const el = await (await fetch('https://www.googleapis.com/civicinfo/v2/elections?key=' +
                                    CONFIG.googleKey)).json();
      const want = state.data.meta.election.date;
      const hit = (el.elections || []).find(e => e.electionDay === want);
      CONFIG.civicElectionId = hit ? hit.id : 0;
    }
    if (!CONFIG.civicElectionId) { line.innerHTML = ''; return; }
    const u = 'https://www.googleapis.com/civicinfo/v2/voterinfo?key=' + CONFIG.googleKey +
              '&electionId=' + CONFIG.civicElectionId +
              '&address=' + encodeURIComponent(origin.addr);
    const r = await (await fetch(u)).json();
    const g = (r.pollingLocations || [])[0];
    /* Civic has nothing for most of the country this far out. A cross check
       that says "no second source" on every single lookup is noise, so it
       stays silent unless it actually has something to add. */
    if (!g) { line.innerHTML = ''; return; }
    const same = String(g.address.line1 || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      .includes(String(poll.addr).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
    line.innerHTML = same
      ? ' Independently confirmed against Google Civic Information.'
      : ' Google Civic reports <b>' + (g.address.locationName || g.address.line1) +
        '</b> for this address. Two sources disagree, so confirm with your clerk before Election Day.';
  } catch (e) {
    line.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ share */

async function share() {
  const o = state.origin, p = state.data.precincts[o.precinct].poll;
  const text = 'I vote at ' + titleCase(p.name) + ', ' + titleCase(p.addr) +
               ', ' + titleCase(p.city) + '. Find yours here.';
  const url = location.href.split('#')[0];
  try {
    if (navigator.share) { await navigator.share({ title: 'Where I vote', text, url }); return; }
    await navigator.clipboard.writeText(text + ' ' + url);
    const b = $('#btnShare'); const was = b.innerHTML;
    b.innerHTML = 'Copied'; setTimeout(() => { b.innerHTML = was; }, 1800);
  } catch (e) { /* user dismissed the sheet */ }
}

boot();
