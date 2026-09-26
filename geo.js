// Waypoint math: positions, head orientation, projection onto the display, step tracking.
// Pure functions and small classes, no DOM, so they can be tested outside the glasses.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const EARTH = 6371008.8;
export const EYE_HEIGHT = 1.6; // metres from the floor to your eyes

export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const wrap180 = (d) => wrap360(d + 180) - 180;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------- positions ----------

/** East/north metres from (lat0, lon0) to (lat, lon). Accurate to well under 1% within a few km. */
export function enu(lat0, lon0, lat, lon) {
  const e = wrap180(lon - lon0) * D2R * EARTH * Math.cos(((lat + lat0) / 2) * D2R);
  const n = (lat - lat0) * D2R * EARTH;
  return { e, n };
}

/** The point e metres east and n metres north of (lat, lon). */
export function offsetLatLon(lat, lon, e, n) {
  const lat2 = lat + (n / EARTH) * R2D;
  const lon2 = lon + (e / (EARTH * Math.cos(((lat + lat2) / 2) * D2R))) * R2D;
  return { lat: lat2, lon: wrap180(lon2) };
}

/** Compass bearing (0 = north, clockwise) and flat distance of an east/north offset. */
export function bearingOf(e, n) {
  return wrap360(Math.atan2(e, n) * R2D);
}

// ---------- small vector/matrix helpers (3x3, row-major) ----------

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const normalize = (a) => { const l = norm(a) || 1; return scale(a, 1 / l); };
export const matT = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
export const matVec = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
export function matMul(A, B) {
  const Bt = matT(B);
  return A.map((row) => Bt.map((col) => dot(row, col)));
}

/** Device -> world (x east, y north, z up) rotation, per the W3C DeviceOrientation spec (Z-X'-Y''). */
export function rotFromEuler(alpha, beta, gamma) {
  const x = beta * D2R, y = gamma * D2R, z = alpha * D2R;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
  const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  return [
    [cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY],
    [cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX],
    [-cX * sY, sX, cX * cY],
  ];
}

/** Snap a nearly-rotation matrix back to a true rotation (Gram-Schmidt on its columns). */
export function orthonormalize(M) {
  let c0 = [M[0][0], M[1][0], M[2][0]];
  let c1 = [M[0][1], M[1][1], M[2][1]];
  c0 = normalize(c0);
  c1 = normalize(sub(c1, scale(c0, dot(c0, c1))));
  const c2 = cross(c0, c1);
  return [[c0[0], c1[0], c2[0]], [c0[1], c1[1], c2[1]], [c0[2], c1[2], c2[2]]];
}

/** Move matrix A a fraction k of the way to B, staying a rotation. Used to steady the view. */
export function blendRot(A, B, k) {
  if (!A) return B;
  const M = A.map((row, i) => row.map((v, j) => v + (B[i][j] - v) * k));
  return orthonormalize(M);
}

/** Average of angles in degrees (handles 359 and 1 correctly). */
export function circMean(degs) {
  let s = 0, c = 0;
  for (const d of degs) { s += Math.sin(d * D2R); c += Math.cos(d * D2R); }
  return wrap360(Math.atan2(s, c) * R2D);
}

// ---------- calibration: which way the glasses face, whatever way the sensor is mounted ----------

/**
 * Three captured poses (each {a, b, g} = alpha/beta/gamma in degrees, or a list of such readings):
 *   level - looking straight ahead at the horizon
 *   right - then turned to the right (about a quarter turn)
 *   down  - then looking down at your feet
 * Works out the glasses' forward/right/up directions in the sensor's own frame, and whether the
 * sensor reports alpha clockwise (a compass heading) or counter-clockwise (the web standard).
 */
export function solveCalibration(level, right, down) {
  const tries = [false, true].map((mirror) => solveOnce(level, right, down, mirror));
  const good = tries.filter((t) => t.ok);
  if (!good.length) return tries[0];
  // The right convention is the one where turning right increases the heading.
  const best = good.find((t) => t.turn > 30);
  if (best) return best;
  return { ok: false, why: "turn", turn: good[0].turn };
}

/** Average orientation of one or more readings ({a, b, g}), averaged as rotations (not angle by angle). */
export function avgRot(readings, mirror) {
  const list = Array.isArray(readings) ? readings : [readings];
  const m = mirror ? -1 : 1;
  const sum = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const r of list) {
    const R = rotFromEuler(m * r.a, r.b, r.g);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sum[i][j] += R[i][j];
  }
  return orthonormalize(sum);
}

function solveOnce(level, right, down, mirror) {
  const R1 = avgRot(level, mirror);
  const R2 = avgRot(right, mirror);
  const R3 = avgRot(down, mirror);
  const up = normalize(matVec(matT(R1), [0, 0, 1])); // world up, seen from the sensor, head level
  const Q = matMul(matT(R1), R3); // the head's nod, in the sensor's frame
  const cosAng = clamp((Q[0][0] + Q[1][1] + Q[2][2] - 1) / 2, -1, 1);
  const downAngle = Math.acos(cosAng) * R2D;
  if (downAngle < 20) return { ok: false, why: "down", downAngle };
  let axis = [Q[2][1] - Q[1][2], Q[0][2] - Q[2][0], Q[1][0] - Q[0][1]];
  axis = sub(axis, scale(up, dot(axis, up)));
  if (norm(axis) < 1e-6) return { ok: false, why: "down", downAngle };
  axis = normalize(axis);
  let fwd = normalize(cross(up, axis));
  // Forward must drop when you look down.
  if (matVec(R3, fwd)[2] > matVec(R1, fwd)[2]) fwd = scale(fwd, -1);
  const rgt = normalize(cross(fwd, up));
  const cal = { ok: true, mirror, fwd, right: rgt, up: cross(rgt, fwd), downAngle, offset: 0 };
  const h1 = headPose(R1, cal).heading, h2 = headPose(R2, cal).heading;
  cal.turn = wrap180(h2 - h1);
  return cal;
}

/** Rotation for a raw orientation reading, honouring the calibration's alpha direction. */
export function rotForReading(a, b, g, cal) {
  return rotFromEuler(cal && cal.mirror ? -a : a, b, g);
}

/** Heading (true, 0-360 clockwise from north, incl. the user's offset) and pitch (up +) of the glasses. */
export function headPose(R, cal) {
  const f = matVec(R, cal.fwd);
  const flat = Math.hypot(f[0], f[1]);
  const heading = wrap360(Math.atan2(f[0], f[1]) * R2D + (cal.offset || 0));
  const pitch = Math.atan2(f[2], flat) * R2D;
  const r = matVec(R, cal.right);
  const roll = Math.asin(clamp(-r[2], -1, 1)) * R2D;
  return { heading, pitch, roll, flat };
}

/**
 * Where a spot appears on the display.
 * rel: {e, n, up} metres from your eyes (true north). Returns screen x/y, depth z (> 0 = in front),
 * and the direction to it on the screen for edge arrows.
 */
export function project(R, cal, rel, focal, cx, cy) {
  // Turn true north into the sensor's north (undo the heading offset).
  const o = -(cal.offset || 0) * D2R;
  const e = rel.e * Math.cos(o) + rel.n * Math.sin(o);
  const n = -rel.e * Math.sin(o) + rel.n * Math.cos(o);
  const world = [e, n, rel.up];
  const dist = norm(world);
  const d = matVec(matT(R), scale(world, 1 / (dist || 1)));
  const x = dot(d, cal.right), y = dot(d, cal.up), z = dot(d, cal.fwd);
  const out = { x: NaN, y: NaN, z, dist, angle: Math.atan2(-y, x) };
  if (z > 0.02) {
    out.x = cx + (x / z) * focal;
    out.y = cy - (y / z) * focal;
  }
  return out;
}

// ---------- position: GPS + step counting ----------

/**
 * Your position in metres (east/north of a working origin), blending steps and GPS.
 * Steps keep it steady indoors and between fixes; GPS pulls it back when it's good.
 */
export class PosFilter {
  constructor() { this.e = 0; this.n = 0; this.P = 1e8; this.has = false; }
  get sigma() { return Math.sqrt(this.P); }
  /** Time passing adds doubt (q in m2 per second): you may have moved without us seeing it. */
  predict(dtSec, q) {
    if (dtSec > 0) this.P += q * Math.min(dtSec, 600);
  }
  step(len, headingDeg) {
    const h = headingDeg * D2R;
    this.e += len * Math.sin(h);
    this.n += len * Math.cos(h);
    this.P += 0.3 * 0.3 + (len * 0.12) ** 2;
  }
  /** A GPS fix at (e, n) with accuracy acc metres. Returns 'first', 'reset' or 'blend'. */
  fix(e, n, acc) {
    // Phones report accuracy conservatively; ~0.6x is closer to the typical error of one fix.
    const Rv = (0.6 * Math.max(acc, 3)) ** 2;
    if (!this.has) { this.e = e; this.n = n; this.P = Rv; this.has = true; return "first"; }
    const dx = e - this.e, dy = n - this.n;
    if (Math.hypot(dx, dy) > 3 * Math.sqrt(this.P + Rv) && acc <= 20) {
      this.e = e; this.n = n; this.P = Rv; return "reset";
    }
    const K = this.P / (this.P + Rv);
    this.e += K * dx; this.n += K * dy;
    // GPS errors drift together from one fix to the next, so many fixes are not much better than one.
    this.P = Math.max(this.P * (1 - K), (0.4 * Math.max(acc, 3)) ** 2);
    return "blend";
  }
  shift(de, dn) { this.e -= de; this.n -= dn; }
}

/** Counts steps from the bounce in the accelerometer (head-worn: a clear up-down each step). */
export class StepDetector {
  constructor() { this.base = null; this.smooth = null; this.high = false; this.last = -1e9; this.count = 0; }
  /** mag: |acceleration incl. gravity| in m/s2; t: ms. Returns true when a step is counted. */
  push(mag, t, sensitivity = 1.2) {
    if (!Number.isFinite(mag)) return false;
    if (this.base === null) { this.base = mag; this.smooth = mag; return false; }
    this.smooth += (mag - this.smooth) * 0.35;
    this.base += (this.smooth - this.base) * 0.02;
    const d = this.smooth - this.base;
    if (!this.high && d > sensitivity && t - this.last > 280) {
      this.high = true; this.last = t; this.count++; return true;
    }
    if (this.high && d < sensitivity * 0.3) this.high = false;
    return false;
  }
}

// ---------- words ----------

export function fmtDist(m, units) {
  if (!Number.isFinite(m)) return "?";
  if (units === "ft") {
    const ft = m * 3.28084;
    if (ft < 10) return `${ft.toFixed(0)} ft`;
    if (ft < 1000) return `${Math.round(ft / 5) * 5} ft`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 10) return `${m.toFixed(1)} m`;
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function cardinal(deg) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(wrap360(deg) / 45) % 8];
}
