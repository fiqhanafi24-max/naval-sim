// Geometry and unit constants. Positions are {lat, lon} in radians, alt in metres.
// Constants mirror GCB2's include/common/math_constants.h.

export const DEG = Math.PI / 180;
export const KTS_TO_MPS = 0.51444444;
export const MPS_TO_KTS = 1 / KTS_TO_MPS;
export const EARTH_R_M = 6378140; // C_RADTOKM * 1000
export const RADAR_HORIZON_K = 3.92482; // km per sqrt(m), C_RADARHOR
export const G_MPS2 = 9.81;
export const TWO_PI = 2 * Math.PI;

/** Map angle to [-pi, pi). */
export function wrapPi(a) {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/** Map angle to [0, 2pi). */
export function wrap2Pi(a) {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

/** Great-circle ground distance in metres. */
export function groundRange_m(a, b) {
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat) * Math.cos(b.lat) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Slant range in metres, including altitude difference. */
export function range3D_m(a, b) {
  const g = groundRange_m(a, b);
  const dz = (b.alt || 0) - (a.alt || 0);
  return Math.sqrt(g * g + dz * dz);
}

/** Initial great-circle bearing from a to b, [0, 2pi). */
export function bearing(a, b) {
  const dLon = b.lon - a.lon;
  const y = Math.sin(dLon) * Math.cos(b.lat);
  const x = Math.cos(a.lat) * Math.sin(b.lat) - Math.sin(a.lat) * Math.cos(b.lat) * Math.cos(dLon);
  return wrap2Pi(Math.atan2(y, x));
}

/** Advance a position along a heading (flat-earth step, as GCB does per frame). */
export function advance(p, distance_m, heading) {
  const d = distance_m / EARTH_R_M;
  p.lat += d * Math.cos(heading);
  p.lon += d * Math.sin(heading) / Math.cos(p.lat);
}

/** Point at a given bearing and distance from p (for scenario setup and track errors). */
export function offset(p, bearing_rad, distance_m) {
  const q = { lat: p.lat, lon: p.lon, alt: p.alt || 0 };
  advance(q, distance_m, bearing_rad);
  return q;
}

/** Local east/north/up offset of b relative to a, in metres. */
export function enu(a, b) {
  return {
    x: (b.lon - a.lon) * Math.cos(a.lat) * EARTH_R_M,
    y: (b.lat - a.lat) * EARTH_R_M,
    z: (b.alt || 0) - (a.alt || 0),
  };
}

/** Velocity vector (east, north, up) in m/s for an object with speed_kts, heading, pitch. */
export function velocity(o) {
  const v = o.speed_kts * KTS_TO_MPS;
  const cp = Math.cos(o.pitch || 0);
  return {
    x: v * cp * Math.sin(o.heading),
    y: v * cp * Math.cos(o.heading),
    z: v * Math.sin(o.pitch || 0),
  };
}

/**
 * 3D intercept solution (port of tcKinematics::GetInterceptData3D).
 * @returns {{heading, pitch, tti_s, range_m}}
 */
export function interceptData3D(own, track) {
  const r = enu(own, track);
  const vt = velocity(track);
  const v = own.speed_kts * KTS_TO_MPS;
  const a = r.x * r.x + r.y * r.y + r.z * r.z;
  const range_m = Math.sqrt(a);
  if (a < 1) return { heading: own.heading, pitch: own.pitch || 0, tti_s: 0, range_m };
  const b = 2 * (r.x * vt.x + r.y * vt.y + r.z * vt.z);
  const c = vt.x * vt.x + vt.y * vt.y + vt.z * vt.z - v * v;
  let det = b * b - 4 * a * c;
  if (det < 0) det = b * b + 4 * a * 0.1 * v * v; // no solution: assume slightly faster
  const k = (-b + Math.sqrt(det)) / (2 * a);
  const vx = vt.x + k * r.x;
  const vy = vt.y + k * r.y;
  const vz = vt.z + k * r.z;
  const vground = Math.hypot(vx, vy);
  const tti_s = Math.abs(r.y) >= Math.abs(r.x) ? r.y / (vy - vt.y) : r.x / (vx - vt.x);
  return {
    heading: wrap2Pi(Math.atan2(vx, vy)),
    pitch: Math.atan(vz / Math.max(vground, 1e-6)),
    tti_s: Number.isFinite(tti_s) ? tti_s : 9999,
    range_m,
  };
}

/**
 * Closest point of approach between two objects assuming constant velocity
 * (port of tcKinematics::CalculateCollisionPoint).
 * @returns {{t, dx, dy, dz, miss_m}} offset of b relative to a at CPA
 */
export function closestApproach(a, b) {
  const r = enu(a, b);
  const va = velocity(a);
  const vb = velocity(b);
  const dv = { x: vb.x - va.x, y: vb.y - va.y, z: vb.z - va.z };
  const dv2 = dv.x * dv.x + dv.y * dv.y + dv.z * dv.z;
  const t = dv2 > 0 ? -(r.x * dv.x + r.y * dv.y + r.z * dv.z) / dv2 : 0;
  const dx = r.x + dv.x * t;
  const dy = r.y + dv.y * t;
  const dz = r.z + dv.z * t;
  return { t, dx, dy, dz, miss_m: Math.sqrt(dx * dx + dy * dy + dz * dz) };
}
