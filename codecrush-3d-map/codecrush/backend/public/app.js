'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ships = [];       // latest authoritative ship state from server
let prevShips = {};   // shipId -> previous position, for interpolation
let zones = [];
let alerts = [];
let ports = [];
let navPolygon = [];
let role = 'command';
let selectedShipId = null;
let modalShipId = null;
let playbackMode = false;
let historySnapshots = [];
let assistanceRequests = [];
let captainRenderKey = '';

const markers = {};       // shipId -> maplibregl.Marker
let map;
let mapReady = false;
let drawMode = false;
let drawPoints = [];      // [lng, lat] pairs while drawing a new zone
let selectedZoneId = null;

const ALERT_ICONS = { geofence_breach: '🚧', proximity_warning: '⚠️', distress: '🆘', distress_escalation: '🆘', out_of_fuel: '⛽', stranded: '🧭', insufficient_fuel: '⛽' };
// OpenStreetMap's standard tile server: free, keyless, no watermark, no
// account. Served as a raster source under MapLibre GL so it can be draped
// over the globe/terrain in 3D and pitched/rotated like any other layer.
const TILE_URLS = ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'];

// ---------------------------------------------------------------------------
// Map setup (MapLibre GL, 3D globe projection)
// ---------------------------------------------------------------------------
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: TILE_URLS,
          tileSize: 256,
          maxzoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: {} }],
      // MapLibre's built-in 3D globe projection - no terrain tiles or API key needed.
      projection: { type: 'globe' },
    },
    center: [55.5, 25.8],
    zoom: 6.2,
    pitch: 55,
    bearing: -12,
    maxPitch: 78,
    attributionControl: false,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('load', () => {
    mapReady = true;

    map.addSource('nav-polygon', { type: 'geojson', data: ringGeoJSON(navPolygon) });
    map.addLayer({ id: 'nav-polygon-fill', type: 'fill', source: 'nav-polygon', paint: { 'fill-color': '#64d2ff', 'fill-opacity': 0.03 } });
    map.addLayer({ id: 'nav-polygon-line', type: 'line', source: 'nav-polygon', paint: { 'line-color': '#64d2ff', 'line-width': 1, 'line-dasharray': [4, 6] } });

    map.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': '#ff453a', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': '#ff453a', 'line-width': 2 } });

    map.addSource('draft-zone', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'draft-zone-fill', type: 'fill', source: 'draft-zone', paint: { 'fill-color': '#ff453a', 'fill-opacity': 0.15 } });
    map.addLayer({ id: 'draft-zone-line', type: 'line', source: 'draft-zone', paint: { 'line-color': '#ff453a', 'line-width': 2, 'line-dasharray': [2, 2] } });

    map.on('click', 'zones-fill', (e) => {
      if (role !== 'command' || drawMode || !e.features.length) return;
      selectZone(e.features[0].properties.id, e.features[0].properties.name);
    });
    map.on('mouseenter', 'zones-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'zones-fill', () => { map.getCanvas().style.cursor = drawMode ? 'crosshair' : ''; });
    map.on('click', handleMapClickForDraw);
    map.on('dblclick', handleMapDblClickForDraw);

    ports.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'port-marker';
      const popup = new maplibregl.Popup({ closeButton: false, offset: 10 }).setText(p.name);
      const portMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.position[1], p.position[0]])
        .setPopup(popup)
        .addTo(map);
      el.addEventListener('mouseenter', () => portMarker.togglePopup());
      el.addEventListener('mouseleave', () => portMarker.togglePopup());
    });

    applyTileTheme();
    renderZones();
    renderShipsOnMap();
  });

  updateDrawControlVisibility();
}

// The dark theme used to invert/hue-rotate the raster tile <img> DOM nodes
// with CSS; under MapLibre the whole map (tiles + zones + ships) is one
// canvas, so re-theming only the base tiles now happens via GL raster paint
// properties on the 'osm' layer instead, leaving markers/zones untouched.
function applyTileTheme() {
  if (!mapReady || !map.getLayer('osm')) return;
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  map.setPaintProperty('osm', 'raster-hue-rotate', dark ? 180 : 0);
  map.setPaintProperty('osm', 'raster-brightness-max', dark ? 0.42 : 1);
  map.setPaintProperty('osm', 'raster-contrast', dark ? -0.1 : 0);
  map.setPaintProperty('osm', 'raster-saturation', dark ? -0.3 : 0);
}
new MutationObserver(applyTileTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function ringGeoJSON(latlngs) {
  if (!latlngs || !latlngs.length) return { type: 'FeatureCollection', features: [] };
  const ring = latlngs.map((p) => [p[1], p[0]]);
  ring.push(ring[0]);
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
}

// ---------------------------------------------------------------------------
// Zone drawing (replaces leaflet-draw): click to add vertices, double-click
// to finish. Editing existing zones is done by deleting and redrawing.
// ---------------------------------------------------------------------------
function updateDrawControlVisibility() {
  const drawBtn = document.getElementById('drawZoneBtn');
  const deleteBtn = document.getElementById('deleteZoneBtn');
  if (drawBtn) drawBtn.classList.toggle('hidden', role !== 'command');
  if (role !== 'command') {
    cancelDraw();
    selectedZoneId = null;
    if (deleteBtn) deleteBtn.classList.add('hidden');
  }
}

function toggleDrawMode() {
  if (drawMode) { cancelDraw(); return; }
  drawMode = true;
  drawPoints = [];
  selectedZoneId = null;
  document.getElementById('deleteZoneBtn').classList.add('hidden');
  const btn = document.getElementById('drawZoneBtn');
  btn.textContent = 'CANCEL (dbl-click to finish)';
  btn.classList.add('active');
  if (mapReady) map.getCanvas().style.cursor = 'crosshair';
}

function cancelDraw() {
  drawMode = false;
  drawPoints = [];
  const btn = document.getElementById('drawZoneBtn');
  if (btn) { btn.textContent = 'DRAW ZONE'; btn.classList.remove('active'); }
  if (mapReady) {
    map.getCanvas().style.cursor = '';
    const src = map.getSource('draft-zone');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }
}

function handleMapClickForDraw(e) {
  if (!drawMode) return;
  drawPoints.push([e.lngLat.lng, e.lngLat.lat]);
  const src = map.getSource('draft-zone');
  if (!src || drawPoints.length < 2) return;
  const ring = drawPoints.concat([drawPoints[0]]);
  src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] });
}

async function handleMapDblClickForDraw(e) {
  if (!drawMode) return;
  e.preventDefault();
  if (drawPoints.length < 3) { cancelDraw(); return; }
  const latlngs = drawPoints.map(([lng, lat]) => [lat, lng]);
  const name = prompt('Name this restricted zone:', `Zone ${zones.length + 1}`) || undefined;
  cancelDraw();
  await fetch(`/api/zones`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, polygon: latlngs }),
  });
}

function selectZone(id, name) {
  selectedZoneId = id;
  const btn = document.getElementById('deleteZoneBtn');
  btn.classList.remove('hidden');
  btn.textContent = `DELETE "${name}"`;
}

function statusColor(status) {
  return {
    normal: '#34c759', rerouting: '#ff9f0a', distressed: '#ff453a', out_of_fuel: '#ff453a',
    stranded: '#ff453a', insufficient_fuel: '#ff9f0a', stopped: '#8e8e93', arrived: '#5e5ce6',
  }[status] || '#8e8e93';
}

function shipIcon(ship) {
  const color = statusColor(ship.status);
  const el = document.createElement('div');
  el.className = 'ship-marker-3d';
  el.innerHTML = `
    <div class="ship-marker-rot" style="transform: rotate(${ship.heading || 0}deg)">
      <svg width="20" height="20" viewBox="0 0 24 24"><path d="M12 2 L20 20 L12 16 L4 20 Z" fill="${color}" stroke="#fff" stroke-width="1"/></svg>
    </div>
    <div class="ship-icon-label">${ship.name}</div>`;
  el.addEventListener('click', (e) => { e.stopPropagation(); openShipDetail(ship.shipId); });
  return el;
}

function updateShipMarkerEl(marker, ship) {
  const el = marker.getElement();
  const rot = el.querySelector('.ship-marker-rot');
  if (rot) rot.style.transform = `rotate(${ship.heading || 0}deg)`;
  const path = el.querySelector('path');
  if (path) path.setAttribute('fill', statusColor(ship.status));
  const label = el.querySelector('.ship-icon-label');
  if (label) label.textContent = ship.name;
}

function renderZones() {
  if (!mapReady) return;
  const src = map.getSource('zones');
  if (!src) return;
  const features = zones.map((z) => {
    const ring = z.polygon.map((p) => [p[1], p[0]]);
    ring.push(ring[0]);
    return { type: 'Feature', properties: { id: z.id, name: z.name }, geometry: { type: 'Polygon', coordinates: [ring] } };
  });
  src.setData({ type: 'FeatureCollection', features });
  const stillExists = new Set(zones.map((z) => z.id));
  if (selectedZoneId && !stillExists.has(selectedZoneId)) {
    selectedZoneId = null;
    document.getElementById('deleteZoneBtn').classList.add('hidden');
  }
}

function renderShipsOnMap() {
  if (!mapReady) return;
  const seen = new Set(ships.map((s) => s.shipId));
  for (const id of Object.keys(markers)) {
    if (!seen.has(id)) { markers[id].remove(); delete markers[id]; }
  }
  ships.forEach((ship) => {
    if (markers[ship.shipId]) {
      updateShipMarkerEl(markers[ship.shipId], ship);
      animateMarkerTo(markers[ship.shipId], ship.position);
    } else {
      const m = new maplibregl.Marker({ element: shipIcon(ship), anchor: 'center' })
        .setLngLat([ship.position[1], ship.position[0]])
        .addTo(map);
      markers[ship.shipId] = m;
    }
  });
}

// Smooth interpolation between ticks (linear lerp over ~1s, respects that we never
// jump further than the reported speed would allow since server already capped it).
function animateMarkerTo(marker, targetPosition) {
  const start = marker.getLngLat();
  const endLat = targetPosition[0], endLng = targetPosition[1];
  if (start.lat === endLat && start.lng === endLng) return;
  const startLat = start.lat, startLng = start.lng;
  const duration = 950; // slightly under tick interval so it settles before next update
  const startTime = performance.now();
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    marker.setLngLat([startLng + (endLng - startLng) * t, startLat + (endLat - startLat) * t]);
    if (t < 1 && marker._animId === reqId) requestAnimationFrame(step);
  }
  const reqId = Symbol();
  marker._animId = reqId;
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Sidebar: ship list
// ---------------------------------------------------------------------------
function renderShipList() {
  const el = document.getElementById('shipList');
  const query = (document.getElementById('shipSearch')?.value || '').trim().toLowerCase();
  const visible = ships.filter((s) => !query || [s.shipId, s.name, s.cargo, s.status, portName(s.destination)].join(' ').toLowerCase().includes(query));
  el.innerHTML = visible.map((s) => `
    <div class="ship-card ${s.shipId === selectedShipId ? 'selected' : ''}" data-ship="${s.shipId}">
      <div class="row"><span class="name">${s.name}</span><span class="ship-status status-${s.status}">${s.status.replace(/_/g,' ')}</span></div>
      <div class="meta">${s.shipId} · ${s.cargo}</div>
      <div class="row meta"><span>${s.speed.toFixed(1)} kt · ${s.heading.toFixed(0)}°</span><span>${s.fuel.toFixed(0)} t</span></div>
      <div class="meta">Destination · ${portName(s.destination)}</div>
    </div>
  `).join('') || '<p class="hint">No vessels match this search.</p>';
  el.querySelectorAll('.ship-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedShipId = card.dataset.ship;
      const sel = document.getElementById('shipSelect');
      if (sel) sel.value = selectedShipId;
      updateSelectedShipBadge();
      if (role === 'captain') {
        document.querySelector('[data-tab="captain"]').click();
        renderCaptainPanel();
      }
      openShipDetail(selectedShipId);
    });
  });
}

function portName(id) {
  const p = ports.find((p) => p.id === id);
  return p ? p.name : id;
}

// ---------------------------------------------------------------------------
// Ship detail modal + directive form (Command only)
// ---------------------------------------------------------------------------
function openShipDetail(shipId) {
  selectedShipId = shipId;
  const sel = document.getElementById('shipSelect');
  if (sel) sel.value = shipId;
  updateSelectedShipBadge();
  modalShipId = shipId;
  const ship = ships.find((s) => s.shipId === shipId);
  if (!ship) return;
  document.getElementById('shipDetailModal').classList.remove('hidden');
  renderShipDetail();
}

// Called every tick while the modal is open: updates ONLY the read-only stats block.
// Deliberately does not touch #directiveForm, so an in-progress dropdown selection
// or typed input in the form is never wiped out by a live server update.
function refreshShipStatsOnly() {
  const ship = ships.find((s) => s.shipId === modalShipId);
  if (!ship) return;
  const body = document.getElementById('shipDetailBody');
  if (!body) return;
  renderShipStatsInto(body, ship);
}

function renderShipStatsInto(body, ship) {
  body.innerHTML = `
    <h3>${ship.name} <small class="muted">${ship.shipId}</small></h3>
    <p><span class="ship-status status-${ship.status}">${ship.status.replace('_',' ')}</span></p>
    <table style="width:100%; font-size:13px;">
      <tr><td class="muted">Cargo</td><td>${ship.cargo}</td></tr>
      <tr><td class="muted">Speed</td><td>${ship.speed.toFixed(1)} kt</td></tr>
      <tr><td class="muted">Heading</td><td>${(ship.heading||0).toFixed(0)}°</td></tr>
      <tr><td class="muted">Fuel</td><td>${ship.fuel.toFixed(0)} t ${ship.fuelInsufficient ? '<span style="color:#ff9f0a">(insufficient for route)</span>' : ''}</td></tr>
      <tr><td class="muted">Destination</td><td>${portName(ship.destination)}</td></tr>
      <tr><td class="muted">Weather</td><td>${ship.weather ? (ship.weather.adverse ? '⛈ adverse' : '☀ clear') + ` (wind ${Math.round(ship.weather.windSpeedKt||0)}kt)` : '—'}</td></tr>
      ${ship.distress ? `<tr><td class="muted">Distress</td><td>${ship.distress.categories.join(', ')} — sev: ${ship.distress.severity}${ship.distress.injuries?`, ${ship.distress.injuries} injured`:''}</td></tr>` : ''}
    </table>
  `;
}

// Full render, including the directive form. Called ONLY when the modal is opened
// or the role is switched — never on a routine tick — so an in-progress dropdown
// selection or typed input is never destroyed mid-interaction.
function renderShipDetail() {
  const ship = ships.find((s) => s.shipId === modalShipId);
  if (!ship) return;
  const body = document.getElementById('shipDetailBody');
  renderShipStatsInto(body, ship);

  const form = document.getElementById('directiveForm');
  if (role === 'command') {
    form.innerHTML = `
      <h4>Issue Directive</h4>
      <select id="directiveType">
        <option value="reroute_port">Reroute to different port</option>
        <option value="divert_waypoint">Divert to waypoint (lat,lng)</option>
        <option value="hold_position">Hold position</option>
      </select>
      <div id="directiveExtra"></div>
      <button id="sendDirectiveBtn">Send Directive</button>
      <button id="routeOptionsBtn" style="background:#fff;color:#1d1d1f;border:1px solid #e0e0e0;border-radius:9999px">Compare routes</button>
      <div id="routeOptions"></div>
      <div id="directiveStatus" class="muted"></div>
    `;
    const extra = document.getElementById('directiveExtra');
    const typeSel = document.getElementById('directiveType');
    function renderExtra() {
      if (typeSel.value === 'reroute_port') {
        extra.innerHTML = `<select id="portSelect">${ports.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}</select>`;
      } else if (typeSel.value === 'divert_waypoint') {
        extra.innerHTML = `<input id="waypointInput" placeholder="lat,lng e.g. 26.1,56.3" />`;
      } else extra.innerHTML = '';
    }
    typeSel.addEventListener('change', renderExtra);
    renderExtra();
    document.getElementById('sendDirectiveBtn').addEventListener('click', sendDirective);
    document.getElementById('routeOptionsBtn').addEventListener('click', loadRouteOptions);
  } else {
    form.innerHTML = ship.lastDirective && ship.lastDirective.status === 'pending' && ship.shipId === selectedShipId
      ? `<p class="muted">Pending directive — respond from the Captain tab.</p>` : '';
  }
}

async function loadRouteOptions() {
  const box = document.getElementById('routeOptions');
  if (!box) return;
  box.innerHTML = '<div class="muted">Calculating candidate routes…</div>';
  try {
    const resp = await fetch(`/api/routes/${modalShipId}/options`);
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || 'Route calculation failed');
    box.innerHTML = (json.options || []).map((o, i) => `
      <div class="route-option">
        <div class="route-head"><span>${o.label}</span><span>${o.distanceKm.toFixed(1)} km</span></div>
        <div class="muted">${o.description} · estimated fuel ${o.estimatedFuel.toFixed(0)} t</div>
        <button class="ghost-btn" data-route-index="${i}" style="color:#1d1d1f;border-color:#e0e0e0">Use this route</button>
      </div>`).join('') || '<div class="muted">No valid alternatives found.</div>';
    box.querySelectorAll('[data-route-index]').forEach(btn => btn.addEventListener('click', async () => {
      const option = json.options[Number(btn.dataset.routeIndex)];
      const r = await fetch(`/api/routes/${modalShipId}/apply`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({waypoints: option.waypoints})});
      document.getElementById('directiveStatus').textContent = r.ok ? 'Route applied to vessel.' : 'Unable to apply route.';
    }));
  } catch (e) { box.innerHTML = `<div class="muted">${e.message}</div>`; }
}

async function sendDirective() {
  const ship = ships.find((s) => s.shipId === modalShipId);
  const type = document.getElementById('directiveType').value;
  let body = { type };
  if (type === 'reroute_port') body.destination = document.getElementById('portSelect').value;
  if (type === 'divert_waypoint') {
    const raw = document.getElementById('waypointInput').value.split(',').map((x) => parseFloat(x.trim()));
    if (raw.length !== 2 || raw.some(isNaN)) { document.getElementById('directiveStatus').textContent = 'Invalid waypoint'; return; }
    body.waypoint = raw;
  }
  const resp = await fetch(`/api/directives/${ship.shipId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('directiveStatus').textContent = resp.ok ? 'Directive sent.' : 'Failed to send directive.';
}

document.getElementById('closeModalBtn').addEventListener('click', () => {
  document.getElementById('shipDetailModal').classList.add('hidden');
  modalShipId = null;
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
function renderAlerts() {
  const el = document.getElementById('alertList');
  const unacked = alerts.filter((a) => !a.acknowledged).length;
  document.getElementById('alertBadge').textContent = unacked;
  el.innerHTML = alerts.map((a) => `
    <div class="alert-card sev-${a.severity} ${a.acknowledged ? 'acked' : ''}">
      <div class="top">
        <span>${ALERT_ICONS[a.type] || '🔔'} ${a.type.replace(/_/g,' ')}</span>
        <span class="alert-time">${new Date(a.createdAt).toLocaleTimeString()}</span>
      </div>
      <div>${a.message}</div>
      ${!a.acknowledged ? `<button data-ack="${a.id}">Acknowledge</button>` : '<span class="muted">acknowledged</span>'}
    </div>
  `).join('');
  el.querySelectorAll('button[data-ack]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/alerts/${btn.dataset.ack}/ack`, { method: 'POST' });
    });
  });
}

let knownAlertIds = new Set();
function maybePlaySound() {
  const newCritical = alerts.filter((a) => !a.acknowledged && !knownAlertIds.has(a.id) && (a.severity === 'high' || a.severity === 'critical'));
  if (newCritical.length) {
    const audio = document.getElementById('alertSound');
    audio.play().catch(() => {});
  }
  knownAlertIds = new Set(alerts.map((a) => a.id));
}

// ---------------------------------------------------------------------------
// Captain tab
// ---------------------------------------------------------------------------
function renderCaptainPanel() {
  const el = document.getElementById('captainPanel');
  if (role !== 'captain' || !selectedShipId) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">⌁</div><strong>Captain console idle</strong><p>Select Captain view and a vessel from the fleet list.</p></div>`;
    captainRenderKey = '';
    return;
  }
  const ship = ships.find((s) => s.shipId === selectedShipId);
  if (!ship) { el.innerHTML = '<p class="hint">Ship not found.</p>'; return; }

  const pending = ship.lastDirective && ship.lastDirective.status === 'pending';
  const activeMission = assistanceRequests.find(r => r.status === 'accepted' && r.helperShipId === ship.shipId);
  const incomingAssistance = assistanceRequests.filter(r => r.status === 'open' && r.shipId !== ship.shipId);
  const incomingHtml = incomingAssistance.length ? `<div class="incoming-assistance"><div class="section-title"><span>03</span> INCOMING ASSISTANCE CALLS</div>${incomingAssistance.map(r => { const requester=ships.find(s=>s.shipId===r.shipId); return `<div class="incoming-card"><div><b>${r.type.replace(/_/g,' ').toUpperCase()}</b><small>${requester?.name || r.shipId}</small></div><p>${r.note || 'No additional details.'}</p><div class="incoming-actions"><button type="button" class="action-btn accept" data-captain-assist-accept="${r.id}">ACCEPT</button><button type="button" class="action-btn danger" data-captain-assist-decline="${r.id}">DECLINE</button></div></div>`; }).join('')}</div>` : '';
  const existingTa = document.getElementById('distressText');
  const savedDistressText = existingTa ? existingTa.value : '';
  const existingNote = document.getElementById('assistanceNote');
  const savedNote = existingNote ? existingNote.value : '';
  const existingType = document.getElementById('assistanceType')?.value || 'medical_aid';

  const directiveHtml = pending ? `
    <div class="directive-box live-card">
      <div class="eyebrow">COMMAND DIRECTIVE</div>
      <strong>${describeDirective(ship.lastDirective)}</strong>
      <div class="directive-actions">
        <button type="button" id="acceptBtn" class="action-btn accept">ACCEPT</button>
        <button type="button" class="action-btn danger" id="escalateBtn">ESCALATE DISTRESS</button>
      </div>
    </div>` : (ship.lastDirective ? `<div class="last-directive">Last directive: ${describeDirective(ship.lastDirective)} <span>${ship.lastDirective.status}</span></div>` : '');

  el.innerHTML = `
    <div class="captain-head">
      <div><div class="eyebrow">VESSEL COMMAND</div><h3>${ship.name}</h3><div class="captain-meta">${ship.shipId} · ${ship.cargo} · ${portName(ship.destination)}</div></div>
      <span class="ship-status captain-live-status status-${ship.status}">${ship.status.replace('_',' ')}</span>
    </div>
    ${directiveHtml}
    <div class="captain-section">
      <div class="section-title"><span>01</span> DISTRESS REPORT</div>
      <textarea id="distressText" placeholder="Describe the emergency in your own words..."></textarea>
      <button type="button" id="fileDistressBtn" class="wide-action">ANALYZE & SEND DISTRESS</button>
      <div id="distressResult" class="result-line"></div>
    </div>
    <div class="captain-section assistance-section">
      <div class="section-title"><span>02</span> SHIP-TO-SHIP ASSISTANCE</div>
      <div class="assistance-grid" id="assistanceGrid">
        <button type="button" class="assist-choice active" data-assist="medical_aid"><b>MED</b><small>Medical aid</small></button>
        <button type="button" class="assist-choice" data-assist="fuel_transfer"><b>FUEL</b><small>Fuel transfer</small></button>
        <button type="button" class="assist-choice" data-assist="escort"><b>ESC</b><small>Escort</small></button>
        <button type="button" class="assist-choice" data-assist="cargo_offload"><b>CARGO</b><small>Cargo offload</small></button>
      </div>
      <input id="assistanceNote" class="assist-note" placeholder="Details — e.g. 2 injured crew members" value="${savedNote.replace(/"/g,'&quot;')}" />
      <button type="button" id="requestAssistanceBtn" class="wide-action accent">BROADCAST ASSISTANCE REQUEST</button>
      <div id="assistanceResult" class="result-line"></div>
      <div class="assistance-mission ${activeMission ? '' : 'hidden'}">${activeMission ? `Active assistance mission: ${activeMission.type.replace(/_/g,' ')} → ${ships.find(s=>s.shipId===activeMission.shipId)?.name || activeMission.shipId}` : ''}</div>
    </div>
    ${incomingHtml}
  `;

  document.querySelectorAll('.assist-choice').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.assist === existingType);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      document.querySelectorAll('.assist-choice').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      btn.blur();
    });
  });
  const acceptBtn = document.getElementById('acceptBtn');
  const escalateBtn = document.getElementById('escalateBtn');
  if (acceptBtn) acceptBtn.addEventListener('click', () => respondDirective('ACCEPT'));
  if (escalateBtn) escalateBtn.addEventListener('click', () => {
    const msg = prompt('Describe the emergency (this becomes your distress report):');
    if (msg) respondDirective('ESCALATE_DISTRESS', msg);
  });

  document.getElementById('requestAssistanceBtn').addEventListener('click', async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    const type = document.querySelector('.assist-choice.active')?.dataset.assist || 'medical_aid';
    const noteEl = document.getElementById('assistanceNote');
    const resultEl = document.getElementById('assistanceResult');
    const note = noteEl?.value.trim() || '';
    if (type === 'medical_aid' && !note) {
      resultEl.textContent = 'Add a medical detail, such as the number of injured crew members.';
      resultEl.className = 'result-line error';
      noteEl?.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'SENDING…';
    try {
      const resp = await fetch(`/api/assistance/${selectedShipId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type, note}) });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Unable to send request.');
      assistanceRequests = assistanceRequests.filter(r => r.id !== json.id);
      assistanceRequests.unshift(json);
      resultEl.className = 'result-line success';
      resultEl.textContent = `Request ${json.id} is live — ${type.replace(/_/g,' ')}.`;
      btn.textContent = 'REQUEST ACTIVE';
    } catch (e) {
      resultEl.className = 'result-line error';
      resultEl.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'BROADCAST ASSISTANCE REQUEST';
    }
  });

  document.querySelectorAll('[data-captain-assist-accept]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'ACCEPTING…';
    const id = btn.dataset.captainAssistAccept;
    const resp = await fetch(`/api/assistance/${id}/accept`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({helperShipId:selectedShipId})});
    const json = await resp.json();
    if (resp.ok) { assistanceRequests = assistanceRequests.map(r => r.id === id ? json : r); renderCaptainPanel(); }
    else { btn.disabled = false; btn.textContent = json.error || 'FAILED'; }
  }));
  document.querySelectorAll('[data-captain-assist-decline]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true; const id = btn.dataset.captainAssistDecline;
    const resp = await fetch(`/api/assistance/${id}/decline`, {method:'POST'}); const json = await resp.json();
    if (resp.ok) { assistanceRequests = assistanceRequests.map(r => r.id === id ? json : r); renderCaptainPanel(); } else btn.disabled = false;
  }));

  document.getElementById('fileDistressBtn').addEventListener('click', async (ev) => {
    ev.preventDefault();
    const text = document.getElementById('distressText').value.trim();
    const out = document.getElementById('distressResult');
    if (!text) { out.textContent = 'Enter a distress message first.'; out.className='result-line error'; return; }
    const resp = await fetch(`/api/captain/${selectedShipId}/distress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
    const json = await resp.json();
    out.className='result-line success';
    out.innerHTML = `Extracted: severity <b>${json.nlpResult.severity}</b> · ${json.nlpResult.categories.join(', ')}${json.nlpResult.injuries ? ` · ${json.nlpResult.injuries} injured` : ''}`;
  });

  const ta = document.getElementById('distressText');
  if (ta) ta.value = savedDistressText;
  captainRenderKey = `${selectedShipId}:${ship.lastDirective?.status || 'none'}`;
}

function updateCaptainLivePanel() {
  if (role !== 'captain' || !selectedShipId) return;
  const ship = ships.find((s) => s.shipId === selectedShipId);
  if (!ship) return;
  const status = document.querySelector('#captainPanel .captain-live-status');
  if (status) {
    status.className = `ship-status captain-live-status status-${ship.status}`;
    status.textContent = ship.status.replace(/_/g, ' ');
  }
  const mission = document.querySelector('#captainPanel .assistance-mission');
  if (mission) {
    const active = assistanceRequests.find(r => r.status === 'accepted' && r.helperShipId === selectedShipId);
    mission.textContent = active ? `Active assistance mission: ${active.type.replace(/_/g,' ')} → ${ships.find(s=>s.shipId===active.shipId)?.name || active.shipId}` : '';
    mission.classList.toggle('hidden', !active);
  }
}

function describeDirective(d) {
  if (d.type === 'reroute_port') return `Reroute to ${portName(d.destination)}`;
  if (d.type === 'divert_waypoint') return `Divert to waypoint [${d.waypoint.join(', ')}]`;
  if (d.type === 'hold_position') return 'Hold position';
  return d.type;
}

async function respondDirective(action, message) {
  await fetch(`/api/captain/${selectedShipId}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, message }) });
}

// ---------------------------------------------------------------------------
// Playback / timeline
// ---------------------------------------------------------------------------
document.getElementById('loadHistoryBtn').addEventListener('click', async () => {
  const resp = await fetch('/api/history?minutes=60');
  const json = await resp.json();
  historySnapshots = json.snapshots;
  const slider = document.getElementById('timelineSlider');
  slider.max = Math.max(0, historySnapshots.length - 1);
  slider.value = slider.max;
  slider.disabled = historySnapshots.length === 0;
  document.getElementById('backToLiveBtn').disabled = false;
  document.getElementById('timelineLabel').textContent = historySnapshots.length ? new Date(historySnapshots[historySnapshots.length-1].ts).toLocaleTimeString() : 'no history yet';
});

document.getElementById('timelineSlider').addEventListener('input', (e) => {
  const idx = parseInt(e.target.value, 10);
  const snap = historySnapshots[idx];
  if (!snap) return;
  playbackMode = true;
  document.getElementById('timelineLabel').textContent = new Date(snap.ts).toLocaleTimeString();
  snap.ships.forEach((s) => {
    if (markers[s.shipId]) markers[s.shipId].setLngLat([s.position[1], s.position[0]]);
  });
});

document.getElementById('backToLiveBtn').addEventListener('click', () => {
  playbackMode = false;
  document.getElementById('timelineLabel').textContent = 'live';
  renderShipsOnMap();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------------------------------------------------------------------------
// Role handling
// ---------------------------------------------------------------------------
document.getElementById('roleSelect').addEventListener('change', (e) => {
  role = e.target.value;
  document.getElementById('shipSelectWrap').style.display = role === 'captain' ? '' : 'none';
  updateDrawControlVisibility();
  renderCaptainPanel();
  if (modalShipId) renderShipDetail();
});

document.getElementById('shipSelect').addEventListener('change', (e) => {
  selectedShipId = e.target.value;
  updateSelectedShipBadge();
  renderShipList();
  renderCaptainPanel();
  openShipDetail(selectedShipId);
});

function updateSelectedShipBadge() {
  const badge = document.getElementById('selectedShipBadge');
  const ship = ships.find(s => s.shipId === selectedShipId);
  if (badge) badge.textContent = ship ? ship.name : '—';
}

let shipSelectPopulated = false;
function populateShipSelect() {
  // The fleet roster is fixed (15 ships, never added/removed), so this only needs to
  // run once. Rebuilding a <select>'s options on every tick can interrupt a user who
  // has the dropdown open mid-click - skip that entirely once it's been built.
  if (shipSelectPopulated) return;
  const sel = document.getElementById('shipSelect');
  if (!ships.length) return;
  sel.innerHTML = ships.map((s) => `<option value="${s.shipId}">${s.name}</option>`).join('');
  if (!selectedShipId || !ships.some(s => s.shipId === selectedShipId)) selectedShipId = ships[0].shipId;
  sel.value = selectedShipId;
  updateSelectedShipBadge();
  shipSelectPopulated = true;
}

document.getElementById('shipSearch').addEventListener('input', renderShipList);
document.getElementById('fitFleetBtn').addEventListener('click', () => {
  if (!ships.length || !mapReady) return;
  const lats = ships.map((s) => s.position[0]), lngs = ships.map((s) => s.position[1]);
  const bounds = new maplibregl.LngLatBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]);
  map.fitBounds(bounds, { padding: 60, maxZoom: 8, pitch: 55 });
});
document.getElementById('drawZoneBtn').addEventListener('click', toggleDrawMode);
document.getElementById('deleteZoneBtn').addEventListener('click', async () => {
  if (!selectedZoneId) return;
  await fetch(`/api/zones/${selectedZoneId}`, { method: 'DELETE' });
  selectedZoneId = null;
  document.getElementById('deleteZoneBtn').classList.add('hidden');
});
document.getElementById('resetTiltBtn').addEventListener('click', () => {
  if (mapReady) map.easeTo({ pitch: 55, bearing: -12, duration: 500 });
});
document.getElementById('collapseSideBtn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('collapsed'));
async function refreshAdvisor() {
  const body = document.getElementById('advisorBody');
  body.innerHTML = '<div class="muted">Reviewing current fleet state…</div>';
  try {
    const r = await fetch('/api/advisor'); const j = await r.json();
    const requests = assistanceRequests.filter(x => x.status === 'open');
    const assistanceHtml = requests.map(x => {
      const requester = ships.find(s => s.shipId === x.shipId);
      const helpers = ships.filter(s => s.shipId !== x.shipId && !['out_of_fuel','stranded','arrived'].includes(s.status));
      return `<div class="advisor-item warning assistance-request-card">
        <div class="request-type"><span>${x.type.replace(/_/g,' ').toUpperCase()}</span><small>${x.id}</small></div>
        <strong>${requester?.name || x.shipId}</strong><p>${x.note || 'No additional details.'}</p>
        <div class="helper-row"><select data-help-for="${x.id}">${helpers.map(s=>`<option value="${s.shipId}">${s.name}</option>`).join('')}</select><button class="primary-btn" data-accept-help="${x.id}" ${helpers.length?'':'disabled'}>DISPATCH</button><button class="ghost-btn" data-decline-help="${x.id}">DECLINE</button></div>
      </div>`;
    }).join('');
    body.innerHTML = (j.recommendations || []).map(x => `<div class="advisor-item ${x.level}"><strong>${x.title}</strong><p>${x.detail}</p></div>`).join('') + (assistanceHtml ? `<div class="eyebrow advisor-divider">OPEN ASSISTANCE REQUESTS</div>${assistanceHtml}` : '<div class="empty-state compact"><strong>No open assistance requests</strong><p>Distress and assistance events will appear here.</p></div>');
    body.querySelectorAll('[data-accept-help]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.acceptHelp; const helper = body.querySelector(`[data-help-for="${id}"]`).value;
      btn.disabled = true; btn.textContent = 'DISPATCHING…';
      const rr = await fetch(`/api/assistance/${id}/accept`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({helperShipId:helper})});
      const rj = await rr.json();
      if (rr.ok) { assistanceRequests = assistanceRequests.map(x => x.id === id ? rj : x); await refreshAdvisor(); }
      else { btn.disabled = false; btn.textContent = rj.error || 'FAILED'; }
    }));
    body.querySelectorAll('[data-decline-help]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.declineHelp;
      const rr = await fetch(`/api/assistance/${id}/decline`, {method:'POST'}); const rj = await rr.json();
      if (rr.ok) { assistanceRequests = assistanceRequests.map(x => x.id === id ? rj : x); await refreshAdvisor(); }
    }));
  } catch(e) { body.innerHTML = '<div class="muted">Advisor unavailable.</div>'; }
}

document.getElementById('advisorBtn').addEventListener('click', async () => {
  document.getElementById('advisorModal').classList.remove('hidden');
  await refreshAdvisor();
});
document.getElementById('closeAdvisorBtn').addEventListener('click', () => document.getElementById('advisorModal').classList.add('hidden'));
document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); }));

function updateDashboardMetrics() {
  const active = ships.filter(s => !['arrived','out_of_fuel','stranded'].includes(s.status)).length;
  const moving = ships.filter(s => s.speed > 0 && !s.arrived).length;
  const critical = ships.filter(s => ['distressed','out_of_fuel','stranded'].includes(s.status)).length;
  document.getElementById('fleetMetric').textContent = `${ships.length} / 15`;
  document.getElementById('topAlertMetric').textContent = alerts.filter(a => !a.acknowledged).length;
  document.getElementById('activeCount').textContent = active;
  document.getElementById('movingCount').textContent = moving;
  document.getElementById('criticalCount').textContent = critical;
  const adverse = ships.filter(s => s.weather && s.weather.adverse).length;
  document.getElementById('weatherMetric').textContent = adverse ? `${adverse} adverse` : 'Stable';
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setConnStatus(true);
  ws.onclose = () => { setConnStatus(false); setTimeout(connectWS, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'init') {
      zones = msg.zones; alerts = msg.alerts; ports = msg.ports; navPolygon = msg.navPolygon;
      ships = msg.ships; assistanceRequests = msg.assistance || [];
      initMap();
      renderZones();
      renderShipsOnMap();
      renderShipList();
      renderAlerts();
      populateShipSelect();
      updateSelectedShipBadge();
      renderCaptainPanel();
      updateDashboardMetrics();
    } else if (msg.type === 'tick') {
      ships = msg.ships; zones = msg.zones; alerts = msg.alerts; assistanceRequests = msg.assistance || assistanceRequests;
      if (!playbackMode) renderShipsOnMap();
      renderZones();
      renderShipList();
      renderAlerts();
      updateSelectedShipBadge();
      maybePlaySound();
      populateShipSelect();
      updateCaptainLivePanel();
      if (modalShipId) refreshShipStatsOnly();
      updateDashboardMetrics();
    } else if (msg.type === 'assistance_request' || msg.type === 'assistance_accepted' || msg.type === 'assistance_declined' || msg.type === 'assistance_completed') {
      assistanceRequests = msg.requests || assistanceRequests;
      if (!document.getElementById('advisorModal').classList.contains('hidden')) refreshAdvisor();
      updateCaptainLivePanel();
    } else if (msg.type === 'directive' || msg.type === 'captain_response' || msg.type === 'distress') {
      renderCaptainPanel();
      if (modalShipId) renderShipDetail();
    }
  };
}

function setConnStatus(connected) {
  const el = document.getElementById('connStatus');
  el.textContent = connected ? 'Live' : 'Reconnecting';
  el.className = 'connection ' + (connected ? 'connected' : 'disconnected');
}

connectWS();

function updateClock(){ const el=document.getElementById('clockReadout'); if(el) el.textContent = new Date().toISOString().slice(11,19) + ' UTC'; }
setInterval(updateClock,1000); updateClock();
