'use strict';
// Geospatial helpers. All positions are [lat, lng]. Distances in km unless noted.

const R_KM = 6371.0088;

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function haversineKm(a, b) {
  const [lat1, lon1] = a, [lat2, lon2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(s));
}

// Initial bearing from a -> b, degrees 0-360 from true north
function bearing(a, b) {
  const [lat1, lon1] = a.map(toRad);
  const [lat2, lon2] = b.map(toRad);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  let brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

// Given a start point, a bearing (deg) and a distance (km), return destination [lat,lng]
function destinationPoint(start, brngDeg, distKm) {
  const brng = toRad(brngDeg);
  const [lat1, lon1] = start.map(toRad);
  const angDist = distKm / R_KM;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
      Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [toDeg(lat2), ((toDeg(lon2) + 540) % 360) - 180];
}

// Ray-casting point-in-polygon. polygon: array of [lat,lng]. point: [lat,lng]
function pointInPolygon(point, polygon) {
  const [y, x] = point; // treat lat as y, lng as x
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Standard 2D segment intersection test (lng=x, lat=y), good enough at this scale
function segmentsIntersect(p1, p2, p3, p4) {
  function ccw(a, b, c) {
    return (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
  }
  const d1 = ccw(p3, p4, p1);
  const d2 = ccw(p3, p4, p2);
  const d3 = ccw(p1, p2, p3);
  const d4 = ccw(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function segmentCrossesPolygon(a, b, polygon) {
  for (let i = 0; i < polygon.length - 1; i++) {
    if (segmentsIntersect(a, b, polygon[i], polygon[i + 1])) return true;
  }
  return false;
}

// Sample a segment and verify every sample point is inside (or right on the edge
// of) the navigable polygon. Boundary-tolerant - see pointInOrOnPolygon above.
function segmentStaysInside(a, b, polygon, samples = 12) {
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (!pointInOrOnPolygon(p, polygon)) return false;
  }
  return true;
}

// Shortest distance (degrees, planar-approx - fine at this scale) from a point to a
// polygon's boundary. Used so points that sit ON or very near an edge (which
// ray-casting can classify either way due to floating point) are still treated as
// "inside enough" - this matters a lot here because navigable-water boundary
// vertices/edges are legitimate route nodes (ships hug the strait's edge).
function distToSegment(p, a, b) {
  const [py, px] = p, [ay, ax] = a, [by, bx] = b;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distToPolygonBoundary(point, polygon) {
  let min = Infinity;
  for (let i = 0; i < polygon.length - 1; i++) {
    const d = distToSegment(point, polygon[i], polygon[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

const BOUNDARY_EPS_DEG = 0.01; // ~1km at these latitudes

function pointInOrOnPolygon(point, polygon, eps = BOUNDARY_EPS_DEG) {
  return pointInPolygon(point, polygon) || distToPolygonBoundary(point, polygon) < eps;
}

function segmentClearOfZones(a, b, zones) {
  for (const z of zones) {
    if (segmentCrossesPolygon(a, b, z.polygon)) return false;
    // also reject if the midpoint sits inside the zone (segment fully inside a convex-ish zone)
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pointInPolygon(mid, z.polygon)) return false;
  }
  return true;
}

module.exports = {
  haversineKm,
  bearing,
  destinationPoint,
  pointInPolygon,
  pointInOrOnPolygon,
  distToPolygonBoundary,
  segmentsIntersect,
  segmentCrossesPolygon,
  segmentStaysInside,
  segmentClearOfZones,
};
