/* =============================================================================
   4 Michigan · Where I Vote
   Public, no sign in, no voter PII. Everything a student sees comes from two
   baked files: data/dorms.json (campuses, buildings, precincts, polls) and
   data/precincts-geo.json (polygons, lazy loaded only for a typed address).
   ========================================================================== */

'use strict';

const CONFIG = {
  /* Basemap: Esri's light canvas, keyless and unwatermarked. Raster and Leaflet
     on purpose. A student opens this on whatever phone they have, so the map
     must not depend on WebGL, a style document, a glyph server or an access
     token, each of which is one more way to hand someone a blank square on the
     morning they need to vote. CARTO's dark tiles were the first choice and
     were dropped: they now stamp API KEY REQUIRED across every tile. */
  tileUrl:  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  labelUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  tileAttribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',

  /* Straight line understates a real walk. Campus paths wander, so multiply by
     a detour factor before converting to minutes, and label it approximate. We
     do not call a routing service: the only keyless one available returns
     driving times from its foot endpoint, and a wrong number on this page is
     worse than an honest estimate. The directions button hands off to Google
     Maps, which does real pedestrian routing. */
  detourFactor: 1.3,
  walkSpeed: 1.35,

  /* Google Cloud API key, deliberately empty. Tested with a real key on
     2026-09-18 and neither half pays off yet. Civic works and knows our
     election but returns zero polling locations nationwide, not just in
     Michigan, because states publish Voting Information Project location data
     close to Election Day. Geocoding refuses referrer restricted keys outright,
     and an unrestricted key has no business in a page anyone can read the
     source of. Re-test Civic in October; setting this is the only change. */
  googleKey: '',
  civicElectionId: null,

  registerUrl: 'https://mvic.sos.state.mi.us/RegisterVoter',
  statusUrl:   'https://mvic.sos.state.mi.us/Voter/Index',
};

/* Campuses whose institution publishes a usable mark. The other seven block
   automated fetching or serve only a 16 pixel icon, and get a typographic chip
   instead, which looks deliberate rather than broken. Drop a 96x96 PNG into
   assets/campus/ named for the slug and add it here to promote one. */
const MARKS = new Set([
  'albion','alma','andrews','cmu','davenport','fsu','gvsu','hope','jackson',
  'lawrence-tech','lmc','michigan-tech','msu','nmu','northwood','nwmc','ou',
  'schoolcraft','uofm-aa','uofm-flint','wmu','wsu',
]);
const slug = k => String(k).toLowerCase().replace(/\s+/g, '-');
const markUrl = k => (MARKS.has(slug(k)) ? 'assets/campus/' + slug(k) + '.png' : null);

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const state = { data: null, guide: null, early: null, geo: null, home: null, registered: null, school: null, origin: null, map: null };

/* ---------------------------------------------------------------- utilities */

const TITLE_SKIP = new Set(['of','the','at','on','and','a','an','for','in','to']);

/* The state layer writes some records in block capitals and others in mixed
   case, so 73 of the 149 polling addresses arrive already cased. Expansion and
   casing are separate steps: everything gets expanded, only shouting gets
   re-cased. Doing both in one pass produced "Bogue Street" on one screen and
   "University Ave" on the next. */
const EXPAND = [
  [/\bSchl\b/gi,'School'],   [/\bBldg\b/gi,'Building'], [/\bElem\b/gi,'Elementary'],
  [/\bCtr\b/gi,'Center'],    [/\bChr?\b/gi,'Church'],   [/\bTwp\b/gi,'Township'],
  [/\bHs\b/gi,'High School'],[/\bJr\b/gi,'Junior'],     [/\bSr\b/gi,'Senior'],
  [/\bLib\b/gi,'Library'],   [/\bCo\b/gi,'County'],     [/\bMem\b/gi,'Memorial'],
  [/\bRd\b/gi,'Road'],       [/\bSt\b/gi,'Street'],     [/\bAve\b/gi,'Avenue'],
  [/\bDr\b/gi,'Drive'],      [/\bBlvd\b/gi,'Boulevard'],[/\bLn\b/gi,'Lane'],
  [/\bPkwy\b/gi,'Parkway'],  [/\bCt\b/gi,'Court'],      [/\bHwy\b/gi,'Highway'],
  [/\bCir\b/gi,'Circle'],    [/\bPl\b/gi,'Place'],      [/\bTer\b/gi,'Terrace'],
  [/\bTrl\b/gi,'Trail'],     [/\bSta\b/gi,'Station'],   [/\bAcad\b/gi,'Academy'],
];
function expand(s) {
  /* St is Saint at the front of a name (ST PAUL LUTHERAN) and Street anywhere
     else (49 ABBOT ST). Resolve that before the table runs, or half the
     churches in the state end up on Street Paul. */
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
  /* Re-capitalise the quadrant suffixes that title casing flattens, so a Grand
     Rapids address reads 940 Baldwin Street SE, not Se. */
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
const fmtDistance = m => (m / 1609.34 < 0.1)
  ? Math.round(m / 0.3048) + ' ft'
  : (m / 1609.34).toFixed(m / 1609.34 < 10 ? 1 : 0) + ' mi';
const walkMinutes = m => Math.max(1, Math.round(m * CONFIG.detourFactor / CONFIG.walkSpeed / 60));

function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) -
            Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/* Ray casting, used only for a typed address. Polygon and MultiPolygon. */
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
  if (el) el.classList.remove('hide');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try { history.replaceState(null, '', '#' + name); } catch (e) {}
}

function initials(name) {
  const w = String(name).replace(/[^A-Za-z ]/g, ' ').split(/\s+/)
    .filter(x => x && !TITLE_SKIP.has(x.toLowerCase()));
  return (w.length === 1 ? w[0].slice(0, 3) : w.slice(0, 3).map(x => x[0]).join('')).toUpperCase();
}
const markHtml = (key, name) => {
  const u = markUrl(key);
  return u ? `<img class="mark" src="${u}" alt="" loading="lazy">`
           : `<span class="initials">${esc(initials(name))}</span>`;
};

/* ----------------------------------------------------------------- combobox */

function makeCombo(root, { placeholder, onPick }) {
  const btn    = $('.combo-input', root);
  const search = $('.combo-search', root);
  const list   = $('.combo-list', root);
  const val    = $('.val', btn);
  let items = [], filtered = [], active = -1;

  function close() {
    root.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function open() {
    root.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    search.value = ''; render('');
    setTimeout(() => search.focus({ preventScroll: true }), 30);
  }
  function render(q) {
    q = q.trim().toLowerCase();
    filtered = q ? items.filter(it => it.search.includes(q)) : items.slice();
    active = -1;
    if (!filtered.length) {
      list.innerHTML = '<div class="combo-empty">Nothing matches that.</div>';
      return;
    }
    list.innerHTML = filtered.map((it, i) =>
      `<button class="opt" type="button" role="option" data-i="${i}">
         ${it.mark}
         <span class="txt"><b>${esc(it.label)}</b>${it.sub ? `<em>${esc(it.sub)}</em>` : ''}</span>
         ${it.tag ? `<span class="tag ${it.tagOn ? 'on' : ''}">${esc(it.tag)}</span>` : ''}
       </button>`).join('');
    $$('.opt', list).forEach(b => b.addEventListener('click', () => choose(filtered[+b.dataset.i])));
  }
  function choose(it) {
    val.classList.remove('ph');
    val.textContent = it.label;
    const old = $('.mark, .initials', btn); if (old) old.remove();
    btn.insertAdjacentHTML('afterbegin', it.mark);
    close();
    onPick(it);
  }

  btn.addEventListener('click', () => (root.classList.contains('open') ? close() : open()));
  search.addEventListener('input', () => render(search.value));
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); btn.focus(); return; }
    if (e.key === 'Enter' && filtered.length) {
      e.preventDefault(); choose(filtered[active >= 0 ? active : 0]); return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const opts = $$('.opt', list); if (!opts.length) return;
    active = e.key === 'ArrowDown'
      ? Math.min(active + 1, opts.length - 1)
      : Math.max(active - 1, 0);
    opts.forEach(o => o.classList.remove('active'));
    opts[active].classList.add('active');
    opts[active].scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener('click', e => { if (!root.contains(e.target)) close(); });

  return {
    setItems(next) { items = next; render(''); },
    reset() {
      val.classList.add('ph'); val.textContent = placeholder;
      const old = $('.mark, .initials', btn); if (old) old.remove();
      close();
    },
  };
}

/* --------------------------------------------------------------------- boot */

const STATES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware',
  'District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky',
  'Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana',
  'Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota',
  'Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas',
  'Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','Outside the United States'];

let schoolCombo, dormCombo, homeCombo;

async function boot() {
  const [data, guide, early] = await Promise.all([
    fetch('data/dorms.json').then(r => r.json()),
    fetch('data/guide.json').then(r => r.json()).catch(() => null),
    fetch('data/early-voting.json').then(r => r.json()).catch(() => null),
  ]);
  state.data = data; state.guide = guide; state.early = early;
  const d = state.data;

  $('#footStamp').textContent = 'Data built ' + d.meta.built + '.';

  const ed = new Date(d.meta.election.date + 'T12:00:00');
  const days = Math.max(0, Math.round((ed - new Date()) / 86400000));
  $('#when').innerHTML = '<b>' +
    ed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
    '</b>' + days + ' days out';

  schoolCombo = makeCombo($('#comboSchool'), {
    placeholder: 'Select your campus',
    onPick: it => pickSchool(it.key),
  });
  dormCombo = makeCombo($('#comboDorm'), {
    placeholder: 'Select your building',
    onPick: it => pickDorm(it.key),
  });

  schoolCombo.setItems(d.schools.map(s => ({
    key: s.k, label: s.n, sub: [s.city, s.count + ' buildings'].filter(Boolean).join(' · '),
    mark: markHtml(s.k, s.n), search: (s.n + ' ' + s.k + ' ' + (s.city || '')).toLowerCase(),
  })));

  homeCombo = makeCombo($('#comboHome'), {
    placeholder: 'Select your home state',
    onPick: it => {
      state.home = it.key;
      /* Michigan is listed first: for a page on 4mich.org it is the answer most
         of the time, and nobody should scroll to M for it. */
      $('#regPanel').classList.remove('hide');
      const rp = $('#regPanel');
      if (rp.scrollIntoView) rp.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });
  homeCombo.setItems([...STATES.filter(x => x === 'Michigan'), ...STATES.filter(x => x !== 'Michigan')]
    .map(x => ({ key: x, label: x, mark: '', search: x.toLowerCase() })));

  $$('[data-reg]').forEach(b => b.addEventListener('click', () => {
    state.registered = b.dataset.reg;
    if (b.dataset.reg === 'yes') return scene('locate');
    renderGuide(b.dataset.reg);
    scene('guide');
  }));

  $$('[data-go]').forEach(b => b.addEventListener('click', () => scene(b.dataset.go)));
  $('#addrGo').addEventListener('click', lookupAddress);
  $('#addrInput').addEventListener('keydown', e => { if (e.key === 'Enter') lookupAddress(); });
  $('#fromChange').addEventListener('click', () => scene('locate'));
  $('#btnShare').addEventListener('click', share);
}

/* ------------------------------------------------------------------- guide */

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtLong(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function renderDates(node, compact) {
  const g = state.guide; if (!g || !node) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let nextMarked = false;
  const rows = compact ? g.dates.filter(x => new Date(x.on + 'T12:00:00') >= today).slice(0, 5) : g.dates;
  node.innerHTML = rows.map(x => {
    const when = new Date(x.on + 'T12:00:00');
    const past = when < today;
    const next = !past && !nextMarked; if (next) nextMarked = true;
    const days = Math.round((when - today) / 86400000);
    return `<li class="${past ? 'past' : ''} ${next ? 'next' : ''}">
      <span class="d">${esc(fmtDate(x.on))}<small>${past ? 'passed' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days'}</small></span>
      <span class="w">${esc(x.what)}</span></li>`;
  }).join('');
}

function renderGuide(reg) {
  const g = state.guide; if (!g) return;
  const mi = state.home === 'Michigan';
  const h = mi ? g.home.mi : g.home.other;
  $('#gHomeTitle').textContent = h.title;
  $('#gHomeBody').textContent = h.body;
  $('#gHomeTip').textContent = h.tip;

  $('#gRegOnline').textContent = g.register.online;
  $('#gRegPerson').textContent = g.register.person;
  $('#gRegNoSsn').textContent = g.register.noSsn;
  $('#gRegStart').href = CONFIG.registerUrl;
  $('#gRegCheck').href = CONFIG.statusUrl;

  $('#gProofIntro').textContent = g.proof.intro;
  $('#gProof').innerHTML = g.proof.items.map(x => '<li>' + esc(x) + '</li>').join('');
  $('#gIdIntro').textContent = g.id.intro;
  $('#gId').innerHTML = g.id.items.map(x => '<li>' + esc(x) + '</li>').join('');
  $('#gIdNone').textContent = g.id.none;

  $('#gEarlyTitle').textContent = g.early.title;
  $('#gEarlyBody').textContent = g.early.body;
  $('#gEarlyCta').href = g.early.lookup;
  $('#gEarlyCtaText').textContent = g.early.cta;

  $('#gEligible').innerHTML = g.eligible.map(x => '<li>' + esc(x) + '</li>').join('');
  renderDates($('#gDates'), false);
  $('#gVerified').textContent = 'Checked against the State of Michigan on ' + g.verified + '.';
}

/* Early voting on the result page. Sites are per city or township, chosen by
   the clerk, and the state publishes no bulk list, so the table is built from
   the program's own clerk confirmed crosswalk (build/build_early.py) and keyed
   by precinct id. A precinct with no confirmed row gets the window and the
   state's own lookup, nothing invented. On campus sites are listed first. */
function renderEarly(code) {
  const g = state.guide; if (!g) return;
  const o = state.origin || {};
  $('#evTitle').textContent = g.early.title;
  $('#evBody').textContent = g.early.body;
  $('#evLookup').href = g.early.lookup;
  $('#evLookup span').textContent = g.early.cta;
  const box = $('#evSites'); box.innerHTML = '';
  const e = state.early && state.early.precincts && state.early.precincts[code];
  if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.confirmed || '') || !e.sites || !e.sites.length) return;
  const sites = e.sites.filter(x => x.name && x.addr)
    .sort((a, b) => (b.campus ? 1 : 0) - (a.campus ? 1 : 0));
  if (!sites.length) return;
  const dir = x => (o.lat && o.lng)
    ? 'https://www.google.com/maps/dir/?api=1&origin=' + o.lat + ',' + o.lng +
      '&destination=' + encodeURIComponent(x.addr) + '&travelmode=walking'
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(x.addr);
  const win = 'The dates and hours are the clerk\'s and can run longer than the statewide window of ' +
    fmtLong(g.early.start) + ' to ' + fmtLong(g.early.end) + '.';
  $('#evTitle').textContent = sites.length === 1 ? 'Your early voting site' : 'Your early voting sites';
  $('#evBody').textContent = sites.length === 1
    ? 'Confirmed with your clerk. Same ballot and same machines as Election Day, with shorter lines. ' + win
    : 'Confirmed with your clerk. Any of them works for you, so pick the closest one. ' + win;
  box.innerHTML = sites.map(x =>
    `<div class="ev-site${x.campus ? ' campus' : ''}"><div>` +
    (x.campus ? '<i class="on-campus">On campus</i>' : '') +
    `<b>${esc(x.name)}</b><span>${esc(x.addr)}</span>` +
    (x.dates ? `<span>${esc(x.dates)}</span>` : '') +
    (x.hours ? `<span>${esc(x.hours)}</span>` : '') +
    `</div><div class="ev-side"><small>Confirmed ${esc(e.confirmed)}</small>` +
    `<a href="${dir(x)}" target="_blank" rel="noopener">Directions</a></div></div>`).join('') +
    (e.satellite && e.satellite.where
      ? `<div class="tip">${esc(e.satellite.where)}${e.satellite.hours ? ' ' + esc(e.satellite.hours) : ''}</div>` : '');
  $('#evLookup span').textContent = 'Check it on the state site';
}

function pickSchool(key) {
  state.school = state.data.schools.find(s => s.k === key);
  const list = state.data.dorms.filter(x => x.s === key)
    .sort((a, b) => a.n.localeCompare(b.n))
    .map(x => ({
      key: x.i, label: x.n,
      sub: [x.a, x.c].filter(Boolean).join(', ') || 'Address on file',
      mark: '', tag: x.on ? 'On campus' : 'Off campus', tagOn: !!x.on,
      search: (x.n + ' ' + (x.a || '') + ' ' + (x.c || '')).toLowerCase(),
    }));
  dormCombo.setItems(list);
  dormCombo.reset();
  $('#buildingBlock').classList.remove('hide');
}

function pickDorm(i) {
  const d = state.data.dorms.find(x => x.i === i);
  state.origin = {
    name: d.n,
    addr: [d.a, d.c, d.z && 'MI ' + d.z].filter(Boolean).join(', ') || d.c,
    lat: d.lat, lng: d.lng, precinct: d.p,
    approx: !!d.approx, chk: d.chk || 0, fix: !!d.fix, dorm: true, school: d.s,
  };
  showResult();
}

/* ------------------------------------------------------------ typed address */

/* Nominatim hands back a long display_name that leads with whatever business
   sits at the address and trails through county and country. Rebuild it as the
   street line a person would write on an envelope. */
function tidyAddress(hit) {
  const a = hit.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const town = a.city || a.town || a.village || a.hamlet || a.township || a.county || '';
  if (street && town) return [street, town, ['MI', a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return String(hit.display_name || '').replace(/,\s*United States$/, '').split(',').slice(0, 4).join(',').trim();
}

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
     not JSON, which is why every step is guarded. */
  const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us' +
            '&addressdetails=1&q=' +
            encodeURIComponent(q.replace(/,?\s*(MI|Michigan)\s*$/i, '') + ', Michigan');
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  let r; try { r = await res.json(); } catch (e) { return null; }
  if (!Array.isArray(r) || !r.length) return null;
  return { lat: +r[0].lat, lng: +r[0].lon, label: tidyAddress(r[0]) };
}

const note = html =>
  '<div class="note"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/>' +
  '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg><div>' +
  html + '</div></div>';

async function lookupAddress() {
  const q = $('#addrInput').value.trim();
  const msg = $('#addrMsg');
  if (q.length < 6) {
    msg.innerHTML = note('Add a little more. A street number and a city works best.');
    return;
  }
  msg.innerHTML = note('Looking that up.');

  let hit = null;
  try { hit = await geocode(q); } catch (e) { hit = null; }
  if (!hit) {
    msg.innerHTML = note('We could not place that address just now. Check the street number and city, or look it up at the ' +
      '<a href="' + CONFIG.statusUrl + '" target="_blank" rel="noopener">Michigan Voter Information Center</a>, which is the state’s own record.');
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
      state.data.meta.counts.precincts + ' precincts covering student housing at our ' +
      state.data.meta.counts.schools + ' campuses. For anywhere else in Michigan the state has you covered at the ' +
      '<a href="' + CONFIG.statusUrl + '" target="_blank" rel="noopener">Michigan Voter Information Center</a>.');
    return;
  }
  msg.innerHTML = '';
  state.origin = { name: q, addr: hit.label, lat: pt.lat, lng: pt.lng,
                   precinct: f.properties.code, approx: false, chk: 0, dorm: false };
  showResult();
}

/* ------------------------------------------------------------------- result */

const factCell = label => $$('#facts .fact').find(f => $('span', f).textContent === label);
const setFactLabel = (label, next) => { const c = factCell(label); if (c) $('span', c).textContent = next; };

function showResult() {
  const o = state.origin;
  const p = state.data.precincts[o.precinct];
  if (!p) return;
  const poll = p.poll, pollPt = { lat: poll.lat, lng: poll.lng };
  const dist = (poll.lat && o.lat) ? haversine(o, pollPt) : null;

  const fm = $('#fromMark'), u = o.dorm ? markUrl(o.school) : null;
  if (u) { fm.src = u; fm.hidden = false; } else { fm.hidden = true; }
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
  $('#pollSub').textContent = p.name + (p.county ? ' · ' + p.county + ' County' : '');

  const facts = [];
  if (dist != null) {
    facts.push(['Straight line', fmtDistance(dist), true]);
    facts.push(['On foot, approx', walkMinutes(dist) + ' min', false]);
  }
  facts.push(['Polls open', '7 am to 8 pm', false]);
  facts.push(['Precinct', p.name.replace(/^.*Precinct\s*/i, 'No. ') || 'On file', false]);
  $('#facts').innerHTML = facts.map(f =>
    `<div class="fact"><span>${esc(f[0])}</span><b class="${f[2] ? 't' : ''}">${esc(f[1])}</b></div>`).join('');

  $('#btnDir').href = 'https://www.google.com/maps/dir/?api=1&origin=' + o.lat + ',' + o.lng +
    '&destination=' + encodeURIComponent(poll.addr + ', ' + poll.city + ', MI') + '&travelmode=walking';
  $('#btnPano').href = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' +
    poll.lat + ',' + poll.lng + '&heading=' + (poll.lat ? Math.round(bearing(o, pollPt)) : 0) + '&pitch=0&fov=80';

  /* Confidence. The baked assignment is voter file sourced and stays the
     answer, but where an independent point in polygon check disagrees we say so
     rather than assert a polling place we cannot corroborate twice. */
  const says = [];
  if (o.chk === 1) says.push('Two independent sources disagree about which precinct this building sits in, usually because the building straddles a precinct line. Confirm with your clerk or on the state site before you go.');
  else if (o.chk === 2) says.push('This building sits on the edge of the precincts we carry, so treat the polling place below as a starting point and confirm it on the state site.');
  if (o.approx) says.push('The pin for your building is approximate, so the walking distance is a close estimate. The polling place itself is exact.');
  const apx = $('#approxNote');
  if (says.length) {
    apx.style.display = '';
    $('#approxText').innerHTML = says.join(' ') +
      ' <a href="' + CONFIG.statusUrl + '" target="_blank" rel="noopener">Check on the state site</a>.';
  } else { apx.style.display = 'none'; }

  $('#prov').innerHTML =
    '<svg class="chk" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>' +
    '<div><b>How we know this.</b> Your building address comes from the 4 Michigan turf record' +
    (o.fix ? ', with the pin corrected by hand after a rooftop geocode of the real address placed it elsewhere. ' : '. ') +
    'The precinct and its polling place come from the State of Michigan published 2026 precinct layer, ' +
    'snapshot <code>' + esc(state.data.meta.snapshot || state.data.meta.built) + '</code>. ' +
    'Precinct code <code>' + esc(o.precinct) + '</code>.' +
    (o.chk ? '' : ' Independently re-checked by dropping this building’s coordinates into the state precinct polygons.') +
    (CONFIG.googleKey ? ' <span id="civicLine"></span>' : '') + '</div>';

  renderEarly(o.precinct);
  scene('result');
  drawMap(o, pollPt, poll).catch(() => {
    $('#mapNote').textContent = 'Map could not load, the links below still work';
  });
  if (CONFIG.googleKey) civicCrossCheck(o, poll);
}

/* ---------------------------------------------------------------------- map */

async function drawMap(origin, pollPt, poll) {
  const node = $('#map');
  if (!poll.lat) { $('#mapNote').textContent = 'No map pin for this polling place yet'; return; }
  if (state.map) { try { state.map.remove(); } catch (e) {} state.map = null; }
  node.innerHTML = '';
  if (typeof L === 'undefined') { $('#mapNote').textContent = 'Map unavailable, the links below still work'; return; }

  /* Deliberately no requestAnimationFrame here. rAF does not fire in a tab the
     browser is not painting, so a student who switches apps for a moment would
     come back to a map that never started. */
  await new Promise(r => setTimeout(r, 0));

  const from = [origin.lat, origin.lng], to = [pollPt.lat, pollPt.lng];
  const map = L.map(node, { zoomControl: true, attributionControl: true, scrollWheelZoom: false })
               .setView([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], 15);
  state.map = map;

  L.tileLayer(CONFIG.tileUrl, { attribution: CONFIG.tileAttribution, maxZoom: 19 }).addTo(map);
  L.tileLayer(CONFIG.labelUrl, { maxZoom: 19, opacity: .85 }).addTo(map);

  const pin = cls => L.divIcon({ className: '', html: '<span class="pin ' + cls + '"></span>',
                                 iconSize: [14, 14], iconAnchor: [7, 7] });
  L.marker(from, { icon: pin('from'), keyboard: false })
    .bindPopup('<b>' + esc(origin.dorm ? origin.name : 'You') + '</b><br>' + esc(origin.addr)).addTo(map);
  L.marker(to, { icon: pin('to'), keyboard: false })
    .bindPopup('<b>' + esc(titleCase(poll.name)) + '</b><br>' + esc(titleCase(poll.addr))).addTo(map);

  L.polyline([from, to], { color: '#0B1F6B', weight: 9, opacity: .12 }).addTo(map);
  L.polyline([from, to], { color: '#0B1F6B', weight: 3, opacity: .95, dashArray: '6 6', lineCap: 'round' }).addTo(map);
  map.fitBounds(L.latLngBounds([from, to]), { padding: [42, 42], maxZoom: 17 });
  $('#mapNote').textContent = 'Straight line to your polling place';
  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 300);
}

/* ------------------------------------------- Civic API, only when keyed */

async function civicCrossCheck(origin, poll) {
  const line = $('#civicLine');
  if (!line) return;
  try {
    if (CONFIG.civicElectionId == null) {
      const el = await (await fetch('https://www.googleapis.com/civicinfo/v2/elections?key=' + CONFIG.googleKey)).json();
      const want = state.data.meta.election.date;
      const hit = (el.elections || []).find(e => e.electionDay === want);
      CONFIG.civicElectionId = hit ? hit.id : 0;
    }
    if (!CONFIG.civicElectionId) { line.innerHTML = ''; return; }
    const u = 'https://www.googleapis.com/civicinfo/v2/voterinfo?key=' + CONFIG.googleKey +
              '&electionId=' + CONFIG.civicElectionId + '&address=' + encodeURIComponent(origin.addr);
    const r = await (await fetch(u)).json();
    const g = (r.pollingLocations || [])[0];
    /* Civic has nothing for most of the country this far out. A cross check
       that says "no second source" on every lookup is noise, so it stays silent
       unless it actually has something to add. */
    if (!g) { line.innerHTML = ''; return; }
    const same = String(g.address.line1 || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      .includes(String(poll.addr).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
    line.innerHTML = same
      ? ' Independently confirmed against Google Civic Information.'
      : ' Google Civic reports <b>' + esc(g.address.locationName || g.address.line1) +
        '</b> for this address. Two sources disagree, so confirm with your clerk before Election Day.';
  } catch (e) { line.innerHTML = ''; }
}

/* -------------------------------------------------------------------- share */

async function share() {
  const o = state.origin, p = state.data.precincts[o.precinct].poll;
  const text = 'I vote at ' + titleCase(p.name) + ', ' + titleCase(p.addr) + ', ' + titleCase(p.city) + '. Find yours here.';
  const url = location.href.split('#')[0];
  try {
    if (navigator.share) { await navigator.share({ title: 'Where I vote', text, url }); return; }
    await navigator.clipboard.writeText(text + ' ' + url);
    const b = $('#btnShare'), was = b.innerHTML;
    b.textContent = 'Copied'; setTimeout(() => { b.innerHTML = was; }, 1800);
  } catch (e) {}
}

window.__locator = { state, renderGuide, renderEarly, pickSchool, pickDorm };
boot();
