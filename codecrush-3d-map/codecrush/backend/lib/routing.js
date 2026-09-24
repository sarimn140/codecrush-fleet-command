'use strict';
/*
 * Routing algorithm: visibility-graph shortest path.
 * Nodes = start, destination, every restricted-zone vertex (nudged outward slightly),
 * and every navigable-water boundary vertex (as a last resort so ships can hug the
 * coastline/strait boundary when a zone blocks the direct line).
 * An edge between two nodes is valid if the straight segment between them:
 *   1. does not cross any restricted zone, and
 *   2. stays inside the navigable-water polygon the whole way.
 * We then run Dijkstra over this graph. Weather is factored in as an edge-cost
 * multiplier so the search prefers paths that avoid the worst adverse-weather cells.
 *
 * This is intentionally a simple, explainable algorithm (the spec explicitly allows
 * "naive but valid" approaches) - it is not a full grid A*, but it satisfies the
 * requirement of staying in navigable water and avoiding zones, and it degrades
 * gracefully to "stranded" when no path exists.
 */
const geo = require('./geo');

function nudgeOutward(polygon, vertex, amountKm = 3) {
  // push a zone vertex slightly away from the polygon centroid so paths can graze past it
  const cLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const cLng = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const brng = geo.bearing([cLat, cLng], vertex);
  return geo.destinationPoint(vertex, brng, amountKm);
}

function buildGraph(start, dest, zones, navPolygon) {
  const nodes = [{ id: 'start', pos: start }, { id: 'dest', pos: dest }];
  zones.forEach((z, zi) => {
    z.polygon.forEach((v, vi) => {
      nodes.push({ id: `z${zi}_${vi}`, pos: nudgeOutward(z.polygon, v) });
    });
  });
  navPolygon.forEach((v, vi) => {
    nodes.push({ id: `n${vi}`, pos: v });
  });
  return nodes;
}

function edgeValid(a, b, zones, navPolygon) {
  if (!geo.segmentClearOfZones(a, b, zones)) return false;
  if (!geo.segmentStaysInside(a, b, navPolygon, 10)) return false;
  return true;
}

function weatherMultiplier(a, b, weatherSampler, weight = 1.6) {
  if (!weatherSampler) return 1;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const w = weatherSampler(mid);
  return w && w.adverse ? weight : 1;
}

// Dijkstra over the visibility graph
function shortestPath(start, dest, zones, navPolygon, weatherSampler, weatherWeight = 1.6) {
  const nodes = buildGraph(start, dest, zones, navPolygon);
  const n = nodes.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(null);
  const visited = new Array(n).fill(false);
  dist[0] = 0;

  // precompute adjacency lazily (n is small: ~2 + zones*4-ish + navPolygon length, fine for O(n^2))
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
    }
    if (u === -1) break;
    visited[u] = true;
    if (u === 1) break; // reached dest node index 1

    for (let v = 0; v < n; v++) {
      if (visited[v] || v === u) continue;
      if (!edgeValid(nodes[u].pos, nodes[v].pos, zones, navPolygon)) continue;
      const base = geo.haversineKm(nodes[u].pos, nodes[v].pos);
      const w = base * weatherMultiplier(nodes[u].pos, nodes[v].pos, weatherSampler, weatherWeight);
      if (dist[u] + w < dist[v]) {
        dist[v] = dist[u] + w;
        prev[v] = u;
      }
    }
  }

  if (dist[1] === Infinity) return null; // no path -> stranded

  const path = [];
  let cur = 1;
  while (cur !== null) {
    path.unshift(nodes[cur].pos);
    cur = prev[cur];
  }
  return path; // includes start as path[0] and dest as path[last]
}

/**
 * computeRoute: main entry point.
 * Returns { waypoints, distanceKm, stranded } where waypoints excludes the current
 * position (it's the list of points still to travel through, ending at destination).
 */
function computeRoute({ position, destination, zones, navPolygon, weatherSampler, weatherWeight = 1.6 }) {
  // fast path: direct line is clear
  if (edgeValid(position, destination, zones, navPolygon)) {
    return {
      waypoints: [destination],
      distanceKm: geo.haversineKm(position, destination),
      stranded: false,
    };
  }
  const path = shortestPath(position, destination, zones, navPolygon, weatherSampler, weatherWeight);
  if (!path) {
    return { waypoints: [], distanceKm: 0, stranded: true };
  }
  const waypoints = path.slice(1); // drop the current position
  let distanceKm = 0;
  for (let i = 0; i < path.length - 1; i++) distanceKm += geo.haversineKm(path[i], path[i + 1]);
  return { waypoints, distanceKm, stranded: false };
}

function computeRouteOptions({ position, destination, zones, navPolygon, weatherSampler }) {
  const profiles = [
    { key: 'fastest', label: 'Fastest', description: 'Shortest navigable path with minimal weather weighting.', weight: 1.0 },
    { key: 'safer', label: 'Safer', description: 'Adds a stronger penalty for adverse-weather segments.', weight: 2.4 },
    { key: 'fuel', label: 'Fuel efficient', description: 'Strongly avoids adverse weather to reduce the 30% fuel penalty.', weight: 3.0 },
  ];
  const options = [];
  for (const profile of profiles) {
    const r = computeRoute({ position, destination, zones, navPolygon, weatherSampler, weatherWeight: profile.weight });
    if (r.stranded) continue;
    const key = r.waypoints.map(p => p.map(v => Number(v.toFixed(4))).join(',')).join('|');
    if (options.some(o => o._key === key)) continue;
    options.push({ key: profile.key, label: profile.label, description: profile.description, waypoints: r.waypoints, distanceKm: r.distanceKm, _key: key });
  }
  return options.map(({ _key, ...o }) => o);
}

module.exports = { computeRoute, computeRouteOptions, edgeValid };
