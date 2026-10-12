'use strict';

// ---------------------------------------------------------------------------
// Base maps
// ---------------------------------------------------------------------------

function rasterStyle(tiles, attribution, maxzoom) {
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom, attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

const BASEMAPS = {
  positron: {
    label: 'OpenFreeMap Positron (light, vector)',
    style: 'https://tiles.openfreemap.org/styles/positron',
  },
  liberty: {
    label: 'OpenFreeMap Liberty (vector)',
    style: 'https://tiles.openfreemap.org/styles/liberty',
  },
  bright: {
    label: 'OpenFreeMap Bright (vector)',
    style: 'https://tiles.openfreemap.org/styles/bright',
  },
  osm: {
    label: 'OpenStreetMap (raster)',
    style: rasterStyle(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      19),
  },
  imagery: {
    label: 'Esri World Imagery (satellite)',
    style: rasterStyle(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      19),
  },
};
const DEFAULT_BASEMAP = 'positron';

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;
const DEG = Math.PI / 180;

function haversineMeters(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Douglas-Peucker on a run of [lon, lat] coordinates, with the tolerance in
// meters. Uses a local equirectangular projection, which is accurate enough at
// the scale of a single track.
function simplify(coords, toleranceM) {
  const n = coords.length;
  if (toleranceM <= 0 || n <= 2) return coords;

  const kx = Math.cos(coords[0][1] * DEG) * EARTH_RADIUS_M * DEG;
  const ky = EARTH_RADIUS_M * DEG;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = coords[i][0] * kx;
    ys[i] = coords[i][1] * ky;
  }

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack = [0, n - 1];
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    const ax = xs[first], ay = ys[first];
    const dx = xs[last] - ax, dy = ys[last] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD2 = -1, maxI = -1;
    for (let i = first + 1; i < last; i++) {
      let px = xs[i] - ax, py = ys[i] - ay;
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        px -= t * dx;
        py -= t * dy;
      }
      const d2 = px * px + py * py;
      if (d2 > maxD2) { maxD2 = d2; maxI = i; }
    }
    if (maxD2 > tol2) {
      keep[maxI] = 1;
      stack.push(first, maxI, maxI, last);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(coords[i]);
  return out;
}

// ---------------------------------------------------------------------------
// GPX parsing
// ---------------------------------------------------------------------------

// Local calendar day as an integer YYYYMMDD, and local seconds since midnight.
function localDayKey(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function localSecondOfDay(d) {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function childText(el, localName) {
  for (const c of el.children) {
    if (c.localName === localName) return c.textContent.trim();
  }
  return null;
}

function buildSegment(name, pts) {
  const n = pts.length;
  const seg = {
    name,
    n,
    lon: new Float64Array(n),
    lat: new Float64Array(n),
    t: new Float64Array(n),
    day: new Int32Array(n),
    sec: new Int32Array(n),
    // speed[i] is the speed in mph from point i to point i + 1.
    speed: new Float32Array(Math.max(0, n - 1)),
    dist: new Float32Array(Math.max(0, n - 1)),
  };
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    seg.lon[i] = p.lon;
    seg.lat[i] = p.lat;
    seg.t[i] = p.t;
    if (Number.isFinite(p.t)) {
      const d = new Date(p.t);
      seg.day[i] = localDayKey(d);
      seg.sec[i] = localSecondOfDay(d);
    } else {
      seg.day[i] = -1;
      seg.sec[i] = -1;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const m = haversineMeters(seg.lon[i], seg.lat[i], seg.lon[i + 1], seg.lat[i + 1]);
    const dt = (seg.t[i + 1] - seg.t[i]) / 1000;
    seg.dist[i] = m;
    seg.speed[i] = dt > 0 ? (m / METERS_PER_MILE) / (dt / 3600) : NaN;
  }
  // Pairs with a zero or negative time step (duplicate timestamps) borrow the
  // speed of a neighboring pair so they don't break the line.
  for (let i = 1; i < n - 1; i++) {
    if (Number.isNaN(seg.speed[i]) && Number.isFinite(seg.t[i]) && Number.isFinite(seg.t[i + 1])) {
      seg.speed[i] = seg.speed[i - 1];
    }
  }
  for (let i = n - 3; i >= 0; i--) {
    if (Number.isNaN(seg.speed[i]) && Number.isFinite(seg.t[i]) && Number.isFinite(seg.t[i + 1])) {
      seg.speed[i] = seg.speed[i + 1];
    }
  }
  return seg;
}

function parseGpx(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('not valid XML');
  }

  const segments = [];
  const addSegment = (name, ptEls) => {
    const pts = [];
    for (const el of ptEls) {
      const lat = parseFloat(el.getAttribute('lat'));
      const lon = parseFloat(el.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const time = childText(el, 'time');
      pts.push({ lon, lat, t: time ? Date.parse(time) : NaN });
    }
    if (pts.length >= 2) segments.push(buildSegment(name, pts));
  };

  for (const trk of doc.getElementsByTagNameNS('*', 'trk')) {
    const name = childText(trk, 'name') || fileName;
    for (const seg of trk.getElementsByTagNameNS('*', 'trkseg')) {
      addSegment(name, seg.getElementsByTagNameNS('*', 'trkpt'));
    }
  }
  for (const rte of doc.getElementsByTagNameNS('*', 'rte')) {
    addSegment(childText(rte, 'name') || fileName, rte.getElementsByTagNameNS('*', 'rtept'));
  }
  return segments;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  segments: [],
  fileCount: 0,
  pointCount: 0,
  minDay: Infinity,
  maxDay: -Infinity,
  bounds: null, // [minLon, minLat, maxLon, maxLat]
  datesTouched: false,
  errors: [],
  geojson: { type: 'FeatureCollection', features: [] },
};

const $ = (id) => document.getElementById(id);
const ui = {
  dateStart: $('date-start'),
  dateEnd: $('date-end'),
  timeStart: $('time-start'),
  timeEnd: $('time-end'),
  speedMin: $('speed-min'),
  speedMax: $('speed-max'),
  maxJump: $('max-jump'),
  lineWidth: $('line-width'),
  lineWidthRange: $('line-width-range'),
  simplify: $('simplify'),
  simplifyRange: $('simplify-range'),
  basemap: $('basemap'),
  stats: $('stats'),
  hint: $('hint'),
};

function dayKeyToInput(k) {
  const y = Math.floor(k / 10000), m = Math.floor(k / 100) % 100, d = k % 100;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function inputToDayKey(v) {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(v);
  return m ? (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]) : null;
}
function inputToSeconds(v) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (m[3] ? +m[3] : 0) : null;
}
function readNumber(input) {
  const v = parseFloat(input.value);
  return Number.isFinite(v) ? v : null;
}

function syncDateInputs() {
  if (!Number.isFinite(state.minDay)) {
    ui.dateStart.value = ui.dateEnd.value = '';
    ui.dateStart.min = ui.dateStart.max = ui.dateEnd.min = ui.dateEnd.max = '';
    return;
  }
  const lo = dayKeyToInput(state.minDay), hi = dayKeyToInput(state.maxDay);
  for (const input of [ui.dateStart, ui.dateEnd]) {
    input.min = lo;
    input.max = hi;
  }
  if (!state.datesTouched) {
    ui.dateStart.value = lo;
    ui.dateEnd.value = hi;
  }
}

function readFilters() {
  const f = {};

  const ds = inputToDayKey(ui.dateStart.value);
  const de = inputToDayKey(ui.dateEnd.value);
  f.dayStart = ds ?? -Infinity;
  f.dayEnd = de ?? Infinity;
  f.dateActive = (ds !== null && ds > state.minDay) || (de !== null && de < state.maxDay);

  const ts = inputToSeconds(ui.timeStart.value) ?? 0;
  // The end time includes its whole minute.
  const te = Math.min(86399, (inputToSeconds(ui.timeEnd.value) ?? 86340) + 59);
  f.secStart = ts;
  f.secEnd = te;
  f.timeActive = !(ts === 0 && te >= 86399);

  const smin = readNumber(ui.speedMin);
  const smax = readNumber(ui.speedMax);
  f.speedMin = smin ?? 0;
  f.speedMax = smax ?? Infinity;
  f.speedActive = f.speedMin > 0 || f.speedMax < Infinity;

  const jump = readNumber(ui.maxJump);
  f.maxJumpM = jump === null ? Infinity : jump * METERS_PER_MILE;

  f.toleranceM = Math.max(0, readNumber(ui.simplify) ?? 0) * METERS_PER_FOOT;
  return f;
}

function pointPasses(seg, i, f) {
  const day = seg.day[i];
  if (day < 0) return !f.dateActive && !f.timeActive;
  if (day < f.dayStart || day > f.dayEnd) return false;
  if (f.timeActive) {
    const s = seg.sec[i];
    if (f.secStart <= f.secEnd) {
      if (s < f.secStart || s > f.secEnd) return false;
    } else if (s < f.secStart && s > f.secEnd) {
      return false; // window wraps past midnight
    }
  }
  return true;
}

function pairPasses(seg, i, f) {
  if (seg.dist[i] > f.maxJumpM) return false;
  if (!f.speedActive) return true;
  const s = seg.speed[i];
  if (Number.isNaN(s)) return false;
  return s >= f.speedMin && s <= f.speedMax;
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function computeFeatures() {
  const f = readFilters();
  const features = [];
  let shownPoints = 0, drawnVertices = 0, shownMeters = 0;

  for (const seg of state.segments) {
    let run = null;
    let runStart = 0;
    let runMeters = 0;
    const flush = (endIdx) => {
      const coords = simplify(run, f.toleranceM);
      shownPoints += run.length;
      drawnVertices += coords.length;
      shownMeters += runMeters;
      features.push({
        type: 'Feature',
        properties: {
          name: seg.name,
          start: fmtTime(seg.t[runStart]),
          end: fmtTime(seg.t[endIdx]),
          miles: runMeters / METERS_PER_MILE,
        },
        geometry: { type: 'LineString', coordinates: coords },
      });
      run = null;
    };

    // A line continues through each consecutive pair of points where both
    // points pass the date and time filters and the pair passes the speed
    // and jump distance filters; anything else breaks it.
    let prevOk = pointPasses(seg, 0, f);
    for (let i = 0; i < seg.n - 1; i++) {
      const nextOk = pointPasses(seg, i + 1, f);
      if (prevOk && nextOk && pairPasses(seg, i, f)) {
        if (!run) {
          run = [[seg.lon[i], seg.lat[i]]];
          runStart = i;
          runMeters = 0;
        }
        run.push([seg.lon[i + 1], seg.lat[i + 1]]);
        runMeters += seg.dist[i];
      } else if (run) {
        flush(i);
      }
      prevOk = nextOk;
    }
    if (run) flush(seg.n - 1);
  }

  state.geojson = { type: 'FeatureCollection', features };
  return { shownPoints, drawnVertices, shownMeters, lines: features.length };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const initialBasemap = BASEMAPS[storageGet('gpsview.basemap')] ? storageGet('gpsview.basemap') : DEFAULT_BASEMAP;

for (const [key, b] of Object.entries(BASEMAPS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = b.label;
  ui.basemap.appendChild(opt);
}
ui.basemap.value = initialBasemap;

const savedLineWidth = parseFloat(storageGet('gpsview.lineWidth'));
if (savedLineWidth > 0) {
  ui.lineWidth.value = String(savedLineWidth);
  ui.lineWidthRange.value = String(Math.min(savedLineWidth, +ui.lineWidthRange.max));
}

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAPS[initialBasemap].style,
  center: [-98.5, 39.8],
  zoom: 3,
  hash: true,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');

const DEFAULT_LINE_WIDTH = 3;

function lineWidth() {
  const v = readNumber(ui.lineWidth);
  return v !== null && v > 0 ? v : DEFAULT_LINE_WIDTH;
}

// The white casing adds up to a pixel on each side, less for thin lines so it
// doesn't swamp them in dense areas.
function casingWidth(w) {
  return w + Math.min(2, w);
}

function applyLineWidth() {
  const w = lineWidth();
  storageSet('gpsview.lineWidth', String(w));
  if (map.getLayer('tracks')) map.setPaintProperty('tracks', 'line-width', w);
  if (map.getLayer('tracks-casing')) map.setPaintProperty('tracks-casing', 'line-width', casingWidth(w));
}

function ensureTrackLayers() {
  if (!map.getSource('tracks')) {
    map.addSource('tracks', { type: 'geojson', data: state.geojson });
  }
  const width = lineWidth();
  if (!map.getLayer('tracks-casing')) {
    map.addLayer({
      id: 'tracks-casing',
      type: 'line',
      source: 'tracks',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-opacity': 0.8,
        'line-width': casingWidth(width),
      },
    });
  }
  if (!map.getLayer('tracks')) {
    map.addLayer({
      id: 'tracks',
      type: 'line',
      source: 'tracks',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#d6336c', 'line-width': width, 'line-opacity': 0.9 },
    });
  }
}

// Fires on the initial load and again after every base map change, which
// discards all sources and layers.
map.on('style.load', () => {
  ensureTrackLayers();
  map.getSource('tracks').setData(state.geojson);
});

map.on('click', 'tracks', (e) => {
  const p = e.features[0].properties;
  const div = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = p.name;
  div.appendChild(title);
  const lines = [];
  if (p.start) lines.push(p.start === p.end ? p.start : `${p.start} – ${p.end}`);
  lines.push(`${Number(p.miles).toFixed(2)} mi shown`);
  for (const line of lines) {
    div.appendChild(document.createElement('br'));
    div.appendChild(document.createTextNode(line));
  }
  new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(div).addTo(map);
});
map.on('mouseenter', 'tracks', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'tracks', () => { map.getCanvas().style.cursor = ''; });

ui.basemap.addEventListener('change', () => {
  const key = ui.basemap.value;
  storageSet('gpsview.basemap', key);
  map.setStyle(BASEMAPS[key].style, { diff: false });
});

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

let pending = false;
function scheduleUpdate() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    update();
  });
}

function update() {
  const r = computeFeatures();
  const src = map.getSource('tracks');
  if (src) src.setData(state.geojson);

  const lines = [];
  if (state.segments.length) {
    lines.push(`${state.fileCount} file${state.fileCount === 1 ? '' : 's'}, ` +
      `${state.pointCount.toLocaleString()} points`);
    lines.push(`Showing ${r.shownPoints.toLocaleString()} points ` +
      `(${r.drawnVertices.toLocaleString()} drawn) in ${r.lines.toLocaleString()} lines, ` +
      `${(r.shownMeters / METERS_PER_MILE).toFixed(1)} mi`);
  }
  for (const err of state.errors) lines.push(err);
  ui.stats.textContent = lines.join('\n');
}

function fitTo(bounds) {
  if (!bounds) return;
  const [a, b, c, d] = bounds;
  if (a === c && b === d) {
    map.jumpTo({ center: [a, b], zoom: 15 });
  } else {
    map.fitBounds([[a, b], [c, d]], { padding: 50, maxZoom: 17, duration: 600 });
  }
}

function featureBounds() {
  let b = null;
  for (const feat of state.geojson.features) {
    for (const [x, y] of feat.geometry.coordinates) {
      if (!b) b = [x, y, x, y];
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
  }
  return b;
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let added = 0;
  for (const file of files) {
    try {
      const segs = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
      if (!segs.length) {
        state.errors.push(`${file.name}: no track points found`);
        continue;
      }
      for (const seg of segs) {
        state.segments.push(seg);
        state.pointCount += seg.n;
        for (let i = 0; i < seg.n; i++) {
          const day = seg.day[i];
          if (day >= 0) {
            if (day < state.minDay) state.minDay = day;
            if (day > state.maxDay) state.maxDay = day;
          }
          const x = seg.lon[i], y = seg.lat[i];
          const b = state.bounds;
          if (!b) state.bounds = [x, y, x, y];
          else {
            if (x < b[0]) b[0] = x;
            if (y < b[1]) b[1] = y;
            if (x > b[2]) b[2] = x;
            if (y > b[3]) b[3] = y;
          }
        }
      }
      state.fileCount++;
      added++;
    } catch (e) {
      state.errors.push(`${file.name}: ${e.message}`);
    }
  }
  if (state.errors.length > 5) state.errors.splice(0, state.errors.length - 5);
  syncDateInputs();
  update();
  if (added) {
    ui.hint.hidden = true;
    fitTo(state.bounds);
  }
}

function clearTracks() {
  Object.assign(state, {
    segments: [], fileCount: 0, pointCount: 0, minDay: Infinity, maxDay: -Infinity,
    bounds: null, datesTouched: false, errors: [],
  });
  ui.hint.hidden = false;
  syncDateInputs();
  update();
}

function resetFilters() {
  state.datesTouched = false;
  syncDateInputs();
  ui.timeStart.value = '00:00';
  ui.timeEnd.value = '23:59';
  ui.speedMin.value = '0';
  ui.speedMax.value = '';
  ui.maxJump.value = '';
  ui.simplify.value = ui.simplifyRange.value = '0';
  update();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const input of [ui.dateStart, ui.dateEnd]) {
  input.addEventListener('input', () => { state.datesTouched = true; scheduleUpdate(); });
  input.addEventListener('change', () => { state.datesTouched = true; scheduleUpdate(); });
}
for (const input of [ui.timeStart, ui.timeEnd, ui.speedMin, ui.speedMax, ui.maxJump]) {
  input.addEventListener('input', scheduleUpdate);
  input.addEventListener('change', scheduleUpdate);
}
ui.simplifyRange.addEventListener('input', () => {
  ui.simplify.value = ui.simplifyRange.value;
  scheduleUpdate();
});
ui.simplify.addEventListener('input', () => {
  const v = readNumber(ui.simplify);
  if (v !== null) ui.simplifyRange.value = String(Math.min(v, +ui.simplifyRange.max));
  scheduleUpdate();
});

ui.lineWidthRange.addEventListener('input', () => {
  ui.lineWidth.value = ui.lineWidthRange.value;
  applyLineWidth();
});
ui.lineWidth.addEventListener('input', () => {
  const v = readNumber(ui.lineWidth);
  if (v !== null) ui.lineWidthRange.value = String(Math.min(v, +ui.lineWidthRange.max));
  applyLineWidth();
});

$('reset').addEventListener('click', resetFilters);
$('fit').addEventListener('click', () => fitTo(featureBounds() || state.bounds));
$('clear').addEventListener('click', clearTracks);
$('collapse').addEventListener('click', () => {
  const collapsed = $('panel').classList.toggle('collapsed');
  $('collapse').textContent = collapsed ? '+' : '–';
});
$('file-input').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  addFiles(e.dataTransfer.files);
});

update();
