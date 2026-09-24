'use strict';
const fs = require('fs');
const path = require('path');
const geo = require('./geo');
const routing = require('./routing');
const weather = require('./weather');

const TICK_MS = 1000; // 1 Hz, satisfies "1Hz or faster"
const PROXIMITY_KM = 2;
const HISTORY_RESOLUTION_MS = 30 * 1000; // 30s snapshots
const HISTORY_WINDOW_MS = 60 * 60 * 1000; // last hour

class Simulation {
  constructor() {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fleet.json'), 'utf8'));
    this.navPolygon = raw.navigableWater;
    this.ports = raw.ports;
    this.portsById = Object.fromEntries(raw.ports.map((p) => [p.id, p]));
    this.ships = raw.fleet.map((s) => ({
      ...s,
      route: [], // upcoming waypoints
      routeDistanceKm: null,
      fuelInsufficient: false,
      arrived: false,
      lastDirective: null,
      lastCaptainResponse: null,
    }));
    this.zones = []; // { id, name, polygon, createdAt }
    this.alerts = []; // { id, type, severity, shipId, message, createdAt, acknowledged }
    this.history = []; // ring buffer of snapshots
    this._alertSeq = 1;
    this._zoneSeq = 1;
    this._listeners = new Set();
    this._lastHistoryPush = 0;
    this._activeProximity = new Set();
    this._assistanceRequests = [];
    this._advisorCache = { ts: 0, recommendations: [] };
    this._predictiveKeys = new Set();

    // compute an initial route for every ship
    for (const ship of this.ships) this._recomputeRoute(ship, 'initial');
  }

  onUpdate(fn) { this._listeners.add(fn); }
  offUpdate(fn) { this._listeners.delete(fn); }
  _emit(event) { for (const fn of this._listeners) fn(event); }

  start() {
    this._interval = setInterval(() => this.tick().catch((e) => console.error('tick error', e)), TICK_MS);
  }
  stop() { clearInterval(this._interval); }

  _recomputeRoute(ship, reason) {
    const port = this.portsById[ship.destination];
    if (!port) return;
    const sampler = weather.makeSampler();
    const result = routing.computeRoute({
      position: ship.position,
      destination: port.position,
      zones: this.zones,
      navPolygon: this.navPolygon,
      weatherSampler: sampler,
    });
    if (result.stranded) {
      ship.status = 'stranded';
      ship.route = [];
      ship.routeDistanceKm = null;
      this._pushAlert('stranded', 'critical', ship.shipId, `${ship.name} is boxed in by restricted zones - no valid path to ${port.name}.`);
    } else {
      ship.route = result.waypoints;
      ship.routeDistanceKm = result.distanceKm;
      if (ship.status === 'stranded') ship.status = 'rerouting';
      this._checkFuelSufficiency(ship);
    }
  }

  _checkFuelSufficiency(ship) {
    // very rough fuel model: consumption ~ proportional to speed^1.6 per km, tuned so
    // the provided starting fuel values are meaningful over strait-length routes.
    if (ship.routeDistanceKm == null) return;
    const burnPerKm = 0.02 * Math.pow(Math.max(ship.speed, 1), 1.3) / 14;
    const estimatedBurn = ship.routeDistanceKm * burnPerKm * 1.15; // small safety margin baked in
    ship.fuelInsufficient = estimatedBurn > ship.fuel;
    if (ship.fuelInsufficient && ship.status === 'normal') ship.status = 'insufficient_fuel';
  }

  getRouteOptions(shipId) {
    const ship = this.ships.find((s) => s.shipId === shipId);
    if (!ship) return null;
    const port = this.portsById[ship.destination];
    if (!port) return { options: [] };
    const options = routing.computeRouteOptions({
      position: ship.position, destination: port.position, zones: this.zones, navPolygon: this.navPolygon, weatherSampler: weather.makeSampler(),
    });
    const burnPerKm = 0.02 * Math.pow(Math.max(ship.speed, 1), 1.3) / 14;
    return { options: options.map(o => ({ ...o, estimatedFuel: o.distanceKm * burnPerKm * (ship.weather?.adverse ? 1.3 : 1) })) };
  }

  applyRoute(shipId, waypoints) {
    const ship = this.ships.find((s) => s.shipId === shipId);
    if (!ship || !Array.isArray(waypoints) || !waypoints.length) return null;
    ship.route = waypoints;
    ship.routeDistanceKm = waypoints.reduce((sum, p, i) => sum + geo.haversineKm(i ? waypoints[i-1] : ship.position, p), 0);
    ship.status = 'rerouting';
    this._checkFuelSufficiency(ship);
    return ship;
  }

  requestAssistance(shipId, type, note = '') {
    const ship = this.ships.find(s => s.shipId === shipId);
    if (!ship) return null;
    const allowed = new Set(['medical_aid','fuel_transfer','escort','cargo_offload']);
    if (!allowed.has(type)) return null;
    const existing = this._assistanceRequests.find(r => r.shipId === shipId && r.status === 'open');
    if (existing) return existing;
    const req = { id: `H-${Date.now()}-${this._assistanceRequests.length+1}`, shipId, type, note, status: 'open', createdAt: Date.now() };
    this._assistanceRequests.unshift(req);
    this._pushAlert('assistance_request', 'high', shipId, `${ship.name} requests ${type.replace('_',' ')} assistance.`);
    return req;
  }

  assistanceList() { return this._assistanceRequests; }

  acceptAssistance(requestId, helperShipId) {
    const req = this._assistanceRequests.find(r => r.id === requestId && r.status === 'open');
    const helper = this.ships.find(s => s.shipId === helperShipId);
    const requester = req ? this.ships.find(s => s.shipId === req.shipId) : null;
    if (!req || !helper || !requester || helper.shipId === requester.shipId || ['out_of_fuel','stranded'].includes(helper.status)) return null;
    req.status = 'accepted'; req.helperShipId = helperShipId; req.acceptedAt = Date.now();
    req.mission = `Respond to ${requester.name} for ${req.type.replace('_',' ')}`;
    helper.assistanceMission = { requestId: req.id, targetShipId: requester.shipId, type: req.type };
    helper.status = 'rerouting';
    this._pushAlert('assistance_dispatched', 'high', helper.shipId, `${helper.name} dispatched to assist ${requester.name} (${req.type.replace('_',' ')}).`);
    return req;
  }

  declineAssistance(requestId) {
    const req = this._assistanceRequests.find(r => r.id === requestId && r.status === 'open');
    if (!req) return null;
    req.status = 'declined'; req.declinedAt = Date.now();
    this._pushAlert('assistance_declined', 'medium', req.shipId, `Assistance request for ${this.ships.find(s=>s.shipId===req.shipId)?.name || req.shipId} was declined.`);
    return req;
  }

  getAdvisor() {
    const recommendations = [];
    const critical = this.ships.filter(s => ['distressed','out_of_fuel','stranded'].includes(s.status));
    const lowFuel = this.ships.filter(s => s.fuelInsufficient && !['arrived','out_of_fuel'].includes(s.status));
    const adverse = this.ships.filter(s => s.weather?.adverse);
    const pending = this.ships.filter(s => s.lastDirective?.status === 'pending');
    if (critical.length) recommendations.push({ level:'critical', title:`${critical.length} vessel${critical.length>1?'s':''} require attention`, detail: critical.map(s=>`${s.name} (${s.status.replace('_',' ')})`).join(', ') + '.' });
    if (lowFuel.length) recommendations.push({ level:'warning', title:'Fuel margin is below route requirement', detail: lowFuel.map(s=>s.name).join(', ') + ' may not have enough fuel for the current planned route.' });
    if (adverse.length) recommendations.push({ level:'warning', title:'Adverse weather on active tracks', detail: adverse.map(s=>s.name).join(', ') + ' are currently inside adverse-weather cells; fuel burn is increased by 30%.' });
    if (pending.length) recommendations.push({ level:'warning', title:'Captain responses pending', detail: pending.map(s=>s.name).join(', ') + ' have unacknowledged directives.' });
    if (!recommendations.length) recommendations.push({ level:'normal', title:'Fleet operating within current thresholds', detail:'No immediate operational exception was detected from the live simulator state.' });
    this._advisorCache = { ts: Date.now(), recommendations };
    return { generatedAt: this._advisorCache.ts, recommendations };
  }

  drawZone(name, polygon) {
    const zone = { id: `Z-${this._zoneSeq++}`, name: name || `Zone ${this._zoneSeq}`, polygon, createdAt: Date.now() };
    this.zones.push(zone);
    // any ship already inside the new zone -> immediate geofence breach + reroute attempt
    for (const ship of this.ships) {
      if (geo.pointInPolygon(ship.position, zone.polygon)) {
        this._pushAlert('geofence_breach', 'high', ship.shipId, `${ship.name} is inside newly-drawn zone "${zone.name}".`);
        ship.status = 'rerouting';
      }
    }
    // any ship whose current path crosses the new zone -> reroute
    for (const ship of this.ships) {
      const fullPath = [ship.position, ...ship.route];
      let crosses = false;
      for (let i = 0; i < fullPath.length - 1; i++) {
        if (geo.segmentCrossesPolygon(fullPath[i], fullPath[i + 1], zone.polygon)) { crosses = true; break; }
      }
      if (crosses) {
        ship.status = 'rerouting';
        this._recomputeRoute(ship, 'zone_drawn');
      }
    }
    return zone;
  }

  editZone(id, polygon) {
    const zone = this.zones.find((z) => z.id === id);
    if (!zone) return null;
    zone.polygon = polygon;
    for (const ship of this.ships) this._recomputeRoute(ship, 'zone_edited');
    return zone;
  }

  deleteZone(id) {
    this.zones = this.zones.filter((z) => z.id !== id);
    for (const ship of this.ships) {
      if (ship.status === 'rerouting' || ship.status === 'stranded') this._recomputeRoute(ship, 'zone_deleted');
    }
  }

  issueDirective(shipId, directive) {
    const ship = this.ships.find((s) => s.shipId === shipId);
    if (!ship) return null;
    ship.lastDirective = { ...directive, issuedAt: Date.now(), status: 'pending' };
    return ship.lastDirective;
  }

  captainRespond(shipId, response) {
    // response: { action: 'ACCEPT' } | { action: 'ESCALATE_DISTRESS', message }
    const ship = this.ships.find((s) => s.shipId === shipId);
    if (!ship || !ship.lastDirective) return null;
    ship.lastDirective.status = response.action === 'ACCEPT' ? 'accepted' : 'escalated';
    ship.lastCaptainResponse = { ...response, respondedAt: Date.now() };

    if (response.action === 'ACCEPT') {
      const d = ship.lastDirective;
      if (d.type === 'reroute_port' && d.destination) ship.destination = d.destination;
      if (d.type === 'divert_waypoint' && d.waypoint) {
        ship.route = [d.waypoint];
        ship.routeDistanceKm = geo.haversineKm(ship.position, d.waypoint);
        this._pendingWaypointThenReroute = ship.shipId; // after reaching waypoint, resume normal routing
      }
      if (d.type === 'hold_position') { ship.status = 'stopped'; ship.speed = 0; }
      if (d.type !== 'hold_position') { ship.status = 'rerouting'; if (d.type !== 'divert_waypoint') this._recomputeRoute(ship, 'directive_accepted'); }
      return { ok: true, ship };
    }

    // escalate to distress -> handled async by caller (nlp), but flag status now
    ship.status = 'distressed';
    this._pushAlert('distress_escalation', 'high', ship.shipId, `${ship.name} escalated a directive to DISTRESS.`);
    return { ok: true, ship, escalated: true, message: response.message };
  }

  fileDistress(shipId, nlpResult) {
    const ship = this.ships.find((s) => s.shipId === shipId);
    if (!ship) return;
    ship.status = 'distressed';
    ship.distress = nlpResult;
    const sevMap = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', unknown: 'medium' };
    this._pushAlert(
      'distress',
      sevMap[nlpResult.severity] || 'medium',
      shipId,
      `${ship.name} DISTRESS: ${nlpResult.categories.join(', ')}${nlpResult.injuries ? ` - ${nlpResult.injuries} injured` : ''}`,
      { nlp: nlpResult }
    );
  }

  _pushAlert(type, severity, shipId, message, extra = {}) {
    const alert = { id: `A-${this._alertSeq++}`, type, severity, shipId, message, createdAt: Date.now(), acknowledged: false, ...extra };
    this.alerts.unshift(alert);
    this.alerts = this.alerts.slice(0, 300);
    return alert;
  }

  acknowledgeAlert(id) {
    const alert = this.alerts.find((a) => a.id === id);
    if (alert) alert.acknowledged = true;
    return alert;
  }

  async tick() {
    const dtSeconds = TICK_MS / 1000;
    await weather.refreshFor(this.ships.map((s) => s.position));
    const sampler = weather.makeSampler();

    for (const ship of this.ships) {
      if (ship.status === 'stopped' || ship.status === 'stranded' || ship.arrived) continue;

      const w = sampler(ship.position[0], ship.position[1]);
      ship.weather = w;

      // Assistance missions dynamically target the requesting vessel.
      // This makes ship-to-ship assistance a real movement/dispatch workflow.
      if (ship.assistanceMission) {
        const targetShip = this.ships.find(s => s.shipId === ship.assistanceMission.targetShipId);
        if (!targetShip) {
          ship.assistanceMission = null;
        } else {
          const missionDistance = geo.haversineKm(ship.position, targetShip.position);
          if (missionDistance <= 2) {
            const req = this._assistanceRequests.find(r => r.id === ship.assistanceMission.requestId);
            if (req && req.status === 'accepted') { req.status = 'completed'; req.completedAt = Date.now(); }
            this._pushAlert('assistance_arrived', 'medium', ship.shipId, `${ship.name} reached ${targetShip.name} to provide ${ship.assistanceMission.type.replace('_',' ')}.`);
            ship.assistanceMission = null;
            if (ship.status === 'rerouting') { ship.status = 'normal'; this._recomputeRoute(ship, 'assistance_complete'); }
            this._emit({ type: 'assistance_completed', request: req || null, requests: this._assistanceRequests });
          }
        }
      }

      // advance toward next waypoint, assistance target, or destination
      const port = this.portsById[ship.destination];
      const assistanceTarget = ship.assistanceMission ? this.ships.find(s => s.shipId === ship.assistanceMission.targetShipId) : null;
      const target = assistanceTarget ? assistanceTarget.position : (ship.route[0] || (port ? port.position : null));
      if (!target) continue;

      const distToTargetKm = geo.haversineKm(ship.position, target);
      const speedKmPerTick = (ship.speed * 1.852) * (dtSeconds / 3600); // knots -> km/h -> km/tick
      ship.heading = geo.bearing(ship.position, target);

      if (speedKmPerTick >= distToTargetKm) {
        ship.position = target;
        if (!assistanceTarget) ship.route.shift();
        if (!assistanceTarget && ship.route.length === 0) {
          if (port && geo.haversineKm(ship.position, port.position) < 0.5) {
            ship.arrived = true;
            ship.status = 'arrived';
            ship.speed = 0;
          } else if (this._pendingWaypointThenReroute === ship.shipId) {
            this._pendingWaypointThenReroute = null;
            this._recomputeRoute(ship, 'resume_after_waypoint');
          }
        }
      } else {
        ship.position = geo.destinationPoint(ship.position, ship.heading, speedKmPerTick);
      }

      // fuel burn
      const baseBurnPerTick = 0.02 * Math.pow(Math.max(ship.speed, 1), 1.3) * (dtSeconds / 3600) * 50;
      const burn = w && w.adverse ? baseBurnPerTick * 1.3 : baseBurnPerTick;
      ship.fuel = Math.max(0, ship.fuel - burn);
      if (ship.fuel <= 0 && ship.status !== 'out_of_fuel') {
        ship.status = 'out_of_fuel';
        ship.speed = 0;
        this._pushAlert('out_of_fuel', 'critical', ship.shipId, `${ship.name} has run out of fuel.`);
      }

      // geofence check against current zones
      for (const zone of this.zones) {
        if (geo.pointInPolygon(ship.position, zone.polygon)) {
          if (!ship._insideZone || ship._insideZone !== zone.id) {
            this._pushAlert('geofence_breach', 'high', ship.shipId, `${ship.name} entered restricted zone "${zone.name}".`);
            ship.status = 'rerouting';
            this._recomputeRoute(ship, 'entered_zone');
          }
          ship._insideZone = zone.id;
        } else if (ship._insideZone === zone.id) {
          ship._insideZone = null;
        }
      }

      if (ship.status === 'rerouting' && ship.route.length === 0) ship.status = 'normal';
    }

    // proximity checks
    for (let i = 0; i < this.ships.length; i++) {
      for (let j = i + 1; j < this.ships.length; j++) {
        const a = this.ships[i], b = this.ships[j];
        const d = geo.haversineKm(a.position, b.position);
        const key = [a.shipId, b.shipId].sort().join('|');
        if (d < PROXIMITY_KM) {
          if (!this._activeProximity) this._activeProximity = new Set();
          if (!this._activeProximity.has(key)) {
            this._activeProximity.add(key);
            this._pushAlert('proximity_warning', 'medium', a.shipId, `${a.name} and ${b.name} are within ${d.toFixed(2)}km of each other.`, { otherShipId: b.shipId, distanceKm: d });
          }
        } else if (this._activeProximity) {
          this._activeProximity.delete(key);
        }
      }
    }

    this._predictiveChecks();
    this._maybeSnapshot();
    this._emit({ type: 'tick', ships: this.ships, zones: this.zones, alerts: this.alerts.slice(0, 50), assistance: this._assistanceRequests });
  }

  _predictiveChecks() {
    const now = Date.now();
    for (const ship of this.ships) {
      if (ship.arrived || ship.status === 'out_of_fuel' || ship.status === 'stranded' || ship.speed <= 0) continue;
      const speedKmH = ship.speed * 1.852;
      const horizonKm = speedKmH * 3 / 60;
      for (const zone of this.zones) {
        if (geo.pointInPolygon(ship.position, zone.polygon)) continue;
        const boundaryKm = geo.distToPolygonBoundary(ship.position, zone.polygon) * 111;
        const key = `zone:${ship.shipId}:${zone.id}`;
        if (boundaryKm <= horizonKm && !this._predictiveKeys.has(key)) {
          this._predictiveKeys.add(key);
          this._pushAlert('predictive_geofence', 'high', ship.shipId, `${ship.name} may enter restricted zone "${zone.name}" within approximately 3 minutes.`);
        } else if (boundaryKm > horizonKm * 1.5) this._predictiveKeys.delete(key);
      }
      if (ship.fuelInsufficient && ship.routeDistanceKm > 0) {
        const burnPerHour = 0.02 * Math.pow(Math.max(ship.speed, 1), 1.3) * 50;
        const hoursLeft = ship.fuel / Math.max(burnPerHour, 0.0001);
        const hoursToRouteEnd = ship.routeDistanceKm / speedKmH;
        const key = `fuel:${ship.shipId}`;
        if (hoursToRouteEnd > hoursLeft && !this._predictiveKeys.has(key)) {
          this._predictiveKeys.add(key);
          this._pushAlert('predictive_fuel', 'high', ship.shipId, `${ship.name} is projected to run out of fuel before completing its current route.`);
        }
      }
    }
  }

  _maybeSnapshot() {
    const now = Date.now();
    if (now - this._lastHistoryPush < HISTORY_RESOLUTION_MS) return;
    this._lastHistoryPush = now;
    this.history.push({
      ts: now,
      ships: this.ships.map((s) => ({ shipId: s.shipId, position: s.position, heading: s.heading, speed: s.speed, status: s.status, fuel: s.fuel })),
      alerts: this.alerts.filter((a) => now - a.createdAt < HISTORY_RESOLUTION_MS).map((a) => ({ id: a.id, type: a.type, severity: a.severity, shipId: a.shipId, message: a.message, createdAt: a.createdAt })),
    });
    const cutoff = now - HISTORY_WINDOW_MS;
    this.history = this.history.filter((h) => h.ts >= cutoff);
  }

  getState() {
    return { ships: this.ships, zones: this.zones, alerts: this.alerts.slice(0, 100), ports: this.ports, navPolygon: this.navPolygon, assistance: this._assistanceRequests };
  }

  getHistory(minutes = 60) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.history.filter((h) => h.ts >= cutoff);
  }
}

module.exports = { Simulation };
