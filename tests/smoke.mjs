/* Headless check of the shipped page. Drives the real flow in jsdom against the
   real data files: register, pick a campus, pick a building, read the result.
   Run: node tests/smoke.mjs                                                   */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from '../../fieldline/node_modules/jsdom/lib/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\n4 Michigan Polling Locator, smoke test\n');

/* ------------------------------------------------------------- 1 the data */
console.log('data');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/dorms.json'), 'utf8'));
ok('dorms.json parses', !!data);
ok('has schools, dorms, precincts', !!(data.schools && data.dorms && data.precincts));
ok('29 schools', data.schools.length === 29, 'got ' + data.schools.length);
ok('736 buildings', data.dorms.length === 736, 'got ' + data.dorms.length);
ok('149 precincts', Object.keys(data.precincts).length === 149);

const orphan = data.dorms.filter(d => !data.precincts[d.p]);
ok('every building maps to a known precinct', orphan.length === 0, orphan.length + ' orphaned');

const noPoll = data.dorms.filter(d => !(data.precincts[d.p].poll || {}).name);
ok('every building has a named polling place', noPoll.length === 0, noPoll.length + ' without');

const noPin = Object.values(data.precincts).filter(p => !p.poll.lat || !p.poll.lng);
ok('every polling place is geocoded', noPin.length === 0, noPin.length + ' unpinned');

const noAddr = data.dorms.filter(d => !d.a && !d.c);
ok('every building has an address or a city', noAddr.length === 0, noAddr.length + ' blank');
ok('no city is blank', data.dorms.filter(d => !d.c).length === 0);

const raw = fs.readFileSync(path.join(ROOT, 'data/dorms.json'), 'utf8');
ok('no voter counts in the public file', !/"(reg|active|youth|youth_pct)":/.test(raw));
ok('no name or birth fields in the public file',
   !/"(first_name|last_name|dob|birth|vanid|voter_id)"/i.test(raw));

/* -------------------------------------------------------- 2 house style */
console.log('\nhouse style');
const sources = ['index.html', 'app.js', 'styles.css', 'README.md', 'data/dorms.json']
  .filter(f => fs.existsSync(path.join(ROOT, f)))
  .map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
for (const [f, txt] of sources) {
  const dashes = (txt.match(/[–—]/g) || []).length;
  ok(f + ' carries no em or en dashes', dashes === 0, dashes + ' found');
}
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
for (const [f, txt] of sources) ok(f + ' carries no emoji', !emoji.test(txt));

/* ------------------------------------------------------------ 3 the page */
console.log('\npage');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js   = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const geo  = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/precincts-geo.json'), 'utf8'));

const dom = new JSDOM(html.replace(/<script src="https:\/\/cdnjs[^<]*<\/script>/, '')
                          .replace(/<script src="app\.js[^"]*"><\/script>/, ''),
  { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://locator.test/' });
const w = dom.window;
w.fetch = async (u) => {
  const file = String(u).includes('precincts-geo') ? 'data/precincts-geo.json' : 'data/dorms.json';
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) };
};
w.scrollTo = () => {};
w.L = undefined;
w.alert = () => {};
w.eval(js);
await new Promise(r => setTimeout(r, 150));

const d = w.document;

/* brand */
ok('real For Michigan logo in the header',
   d.querySelector('.band img.logo').getAttribute('src') === 'assets/fm-logo.png');
ok('navy band carries the tool name in the site\u2019s voice',
   d.querySelector('.band .kicker').textContent === 'Voting resources' &&
   d.querySelector('.band h1').textContent === 'Where I Vote');
ok('page is the website\u2019s light theme, not the field suite\u2019s dark one',
   /--navy:#0B1F6B/.test(fs.readFileSync(path.join(ROOT,'styles.css'),'utf8')) &&
   /--sky:#4FC3F7/.test(fs.readFileSync(path.join(ROOT,'styles.css'),'utf8')) &&
   !/#0c0d10|#0A1020/i.test(fs.readFileSync(path.join(ROOT,'styles.css'),'utf8')));
ok('site fonts loaded: Bebas Neue and Space Grotesk',
   /Bebas\+Neue/.test(html) && /Space\+Grotesk/.test(html));
ok('election date and countdown shown', /2026/.test(d.querySelector('#when').textContent) &&
   /days out/.test(d.querySelector('#when').textContent));

/* the thing Abbie asked for: dropdowns, not tiles */
ok('no tile grid anywhere', !d.querySelector('.schools, .school, .tile'));
ok('campus control is a combobox',
   !!d.querySelector('#comboSchool .combo-input[aria-haspopup="listbox"]'));
ok('building control is a combobox',
   !!d.querySelector('#comboDorm .combo-input[aria-haspopup="listbox"]'));
ok('building picker hidden until a campus is chosen',
   d.querySelector('#buildingBlock').classList.contains('hide'));

/* registration routing */
d.querySelector('[data-reg="no"]').dispatchEvent(new w.Event('click', { bubbles: true }));
ok('answering "not yet" routes to registration',
   !d.querySelector('#scene-register').classList.contains('hide'));
ok('registration links to the state', d.querySelector('#regStart').href.includes('sos.state.mi.us'));
d.querySelector('[data-reg="yes"]').dispatchEvent(new w.Event('click', { bubbles: true }));
ok('answering "yes" routes to the picker',
   !d.querySelector('#scene-locate').classList.contains('hide'));

/* campus dropdown */
d.querySelector('#comboSchool .combo-input').dispatchEvent(new w.Event('click', { bubbles: true }));
ok('campus dropdown opens', d.querySelector('#comboSchool').classList.contains('open'));
const sOpts = d.querySelectorAll('#comboSchool .combo-list .opt');
ok('all 29 campuses listed', sOpts.length === 29, sOpts.length + ' listed');

const withMark = d.querySelectorAll('#comboSchool .combo-list .opt img.mark').length;
const withInit = d.querySelectorAll('#comboSchool .combo-list .opt .initials').length;
ok('22 campuses show a real mark', withMark === 22, withMark + ' marks');
ok('the other 7 fall back to a typographic chip', withInit === 7, withInit + ' chips');
ok('every campus row has one or the other', withMark + withInit === 29);

const ss = d.querySelector('#comboSchool .combo-search');
ss.value = 'michigan state';
ss.dispatchEvent(new w.Event('input', { bubbles: true }));
ok('campus search narrows the list',
   d.querySelectorAll('#comboSchool .combo-list .opt').length === 1);
d.querySelector('#comboSchool .combo-list .opt').dispatchEvent(new w.Event('click', { bubbles: true }));
ok('picking a campus reveals the building picker',
   !d.querySelector('#buildingBlock').classList.contains('hide'));
ok('campus dropdown closes on pick', !d.querySelector('#comboSchool').classList.contains('open'));

/* building dropdown */
d.querySelector('#comboDorm .combo-input').dispatchEvent(new w.Event('click', { bubbles: true }));
const msuCount = data.dorms.filter(x => x.s === 'MSU').length;
ok('all MSU buildings listed',
   d.querySelectorAll('#comboDorm .combo-list .opt').length === msuCount);
const ds = d.querySelector('#comboDorm .combo-search');
ds.value = 'abbot hall';
ds.dispatchEvent(new w.Event('input', { bubbles: true }));
const dOpts = d.querySelectorAll('#comboDorm .combo-list .opt');
ok('building search finds Abbot Hall', dOpts.length >= 1 && /Abbot Hall/.test(dOpts[0].textContent));
dOpts[0].dispatchEvent(new w.Event('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 60));

ok('picking a building shows the result',
   !d.querySelector('#scene-result').classList.contains('hide'));
const pollName = d.querySelector('#pollName').textContent;
ok('polling place named', pollName.length > 2, pollName);
ok('polling place is title case, not shouting', pollName !== pollName.toUpperCase(), pollName);
ok('polling place addressed', /\d/.test(d.querySelector('#pollAddr').textContent));
ok('origin address shown back', d.querySelector('#fromAddr').textContent.length > 4);
ok('campus mark carried onto the result', d.querySelector('#fromMark').hidden === false);
ok('distance and walk time present', d.querySelectorAll('#facts .fact').length >= 3);
ok('distance is labelled straight line, not a routed walk',
   /Straight line/.test(d.querySelector('#facts').textContent));
ok('directions deep link built',
   d.querySelector('#btnDir').href.includes('google.com/maps/dir') &&
   d.querySelector('#btnDir').href.includes('travelmode=walking'));
ok('street view deep link built', d.querySelector('#btnPano').href.includes('map_action=pano'));
ok('provenance names the state layer', /State of Michigan/.test(d.querySelector('#prov').textContent));
ok('provenance prints the precinct code', /\d{13}/.test(d.querySelector('#prov').textContent));

const abbot = data.dorms.find(x => x.s === 'MSU' && /^Abbot Hall/i.test(x.n));
ok('Abbot Hall resolves to precinct 0652412000010', abbot.p === '0652412000010', abbot.p);
ok('that precinct votes at the Union building',
   /UNION/i.test(data.precincts[abbot.p].poll.name), data.precincts[abbot.p].poll.name);

/* assets referenced must exist on disk */
console.log('\nassets');
ok('For Michigan logo file present', fs.existsSync(path.join(ROOT, 'assets/fm-logo.png')));
const marksOnPage = [...d.querySelectorAll('#comboSchool .combo-list img.mark')]
  .map(i => i.getAttribute('src'));
const missing = marksOnPage.filter(s => !fs.existsSync(path.join(ROOT, s)));
ok('every campus mark the page references exists', missing.length === 0, missing.join(', '));

/* ---------------------------------------------- 4 the address fallback */
console.log('\naddress fallback');
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt.lat) !== (yj > pt.lat) &&
        pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inFeature(pt, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some(p => p.length && pointInRing(pt, p[0]) &&
    !p.slice(1).some(h => pointInRing(pt, h)));
}
const hit = geo.features.find(f => inFeature({ lat: abbot.lat, lng: abbot.lng }, f.geometry));
ok('point in polygon puts Abbot Hall in its own precinct',
   hit && hit.properties.code === abbot.p, hit ? hit.properties.code : 'no match');

const far = geo.features.find(f => inFeature({ lat: 45.02, lng: -84.67 }, f.geometry));
ok('a point far from any campus matches nothing', !far);

let agree = 0, tested = 0;
for (const dm of data.dorms) {
  const f = geo.features.find(ft => inFeature({ lat: dm.lat, lng: dm.lng }, ft.geometry));
  if (!f) continue;
  tested++; if (f.properties.code === dm.p) agree++;
}
const pct = (agree / tested * 100);
ok('polygons agree with the baked precinct on 95 percent or better',
   pct >= 95, agree + '/' + tested + ' = ' + pct.toFixed(1) + '%');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
