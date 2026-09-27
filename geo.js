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

// ---------- small vector helpers ----------

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const normalize = (a) => { const l = norm(a) || 1; return scale(a, 1 / l); };
/** Average of angles in degrees (handles 359 and 1 correctly). */
export function circMean(degs) {
  let s = 0, c = 0;
  for (const d of degs) { s += Math.sin(d * D2R); c += Math.cos(d * D2R); }
  return wrap360(Math.atan2(s, c) * R2D);
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

// ---------- v3: trust the glasses' own compass heading ----------
// Meta's docs: alpha is the compass heading (0 = north), beta tilt, gamma roll. Calibration only
// learns which way each reading turns: turning right must raise the heading, looking down must lower
// the pitch. No 3D reconstruction from angles (that's what made v1/v2 drift).

/** Mean of a list of readings ({a, b, g}), each angle averaged on the circle. */
export function meanReading(list) {
  const arr = Array.isArray(list) ? list : [list];
  return {
    a: circMean(arr.map((r) => r.a)),
    b: wrap180(circMean(arr.map((r) => r.b))),
    g: wrap180(circMean(arr.map((r) => r.g))),
  };
}

/** level / right / down: readings (or lists) looking level, then turned right, then looking down. */
export function solveSimpleCal(level, right, down) {
  const L = meanReading(level), Rr = meanReading(right), D = meanReading(down);
  const turn = wrap180(Rr.a - L.a);
  if (Math.abs(turn) < 30) return { ok: false, why: "turn", turn };
  const db = wrap180(D.b - L.b), dg = wrap180(D.g - L.g);
  const pAxis = Math.abs(db) >= Math.abs(dg) ? "b" : "g";
  const d = pAxis === "b" ? db : dg;
  if (Math.abs(d) < 20) return { ok: false, why: "down", d };
  return { ok: true, kind: "simple", hSign: turn > 0 ? 1 : -1, pAxis, pSign: d < 0 ? 1 : -1, pZero: L[pAxis], turn, down: d };
}

/** Heading (0-360 clockwise, as the glasses' compass reports it) and pitch (up +) from one reading. */
export function readPose(r, cal) {
  return { heading: wrap360(cal.hSign * r.a), pitch: cal.pSign * wrap180(r[cal.pAxis] - cal.pZero) };
}

/**
 * Where a spot appears on the display for a head at (heading, pitch).
 * rel: {e, n, up} metres from your eyes, true north. Returns screen x/y (NaN if behind) and depth z.
 */
export function projectHP(heading, pitch, rel, focal, cx, cy) {
  const h = heading * D2R, p = pitch * D2R;
  const f = [Math.cos(p) * Math.sin(h), Math.cos(p) * Math.cos(h), Math.sin(p)];
  const r = [Math.cos(h), -Math.sin(h), 0];
  const u = cross(r, f);
  const w = [rel.e, rel.n, rel.up];
  const dist = norm(w);
  const d = scale(w, 1 / (dist || 1));
  const x = dot(d, r), y = dot(d, u), z = dot(d, f);
  const out = { x: NaN, y: NaN, z, dist };
  if (z > 0.02) { out.x = cx + (x / z) * focal; out.y = cy - (y / z) * focal; }
  return out;
}

/** Running average of angles (degrees) that follows slowly: k per update (0-1). */
export class AngleAvg {
  constructor(k) { this.k = k; this.c = null; this.s = null; }
  push(deg) {
    const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
    if (this.c === null) { this.c = c; this.s = s; } else { this.c += (c - this.c) * this.k; this.s += (s - this.s) * this.k; }
    return this.value;
  }
  get value() { return this.c === null ? null : wrap360(Math.atan2(this.s, this.c) * R2D); }
  get steadiness() { return this.c === null ? 0 : Math.hypot(this.c, this.s); }
}

/**
 * Learns the fixed difference between where the glasses say they point and true north, from walking:
 * GPS says which way you're moving; while you walk looking ahead, that's where your head points.
 */
export class HeadingAligner {
  constructor(state) { Object.assign(this, { sx: 0, sy: 0, n: 0, value: null }, state || {}); }
  /** course: GPS direction of travel; head: glasses' heading (uncorrected). Returns true when updated. */
  add(course, head) {
    const d = wrap180(course - head) * D2R;
    const decay = this.n >= 40 ? 0.975 : 1; // keep adapting slowly once well learned
    this.sx = this.sx * decay + Math.cos(d);
    this.sy = this.sy * decay + Math.sin(d);
    this.n = Math.min(this.n + 1, 40);
    const len = Math.hypot(this.sx, this.sy);
    const R = len / this.n; // resultant length per sample (1 = perfectly consistent); weights sum to n even with decay
    if (this.n >= 6 && R > 0.8) { this.value = wrap180(Math.atan2(this.sy, this.sx) * R2D); return true; }
    return false;
  }
  get ready() { return this.value !== null; }
  toJSON() { return { sx: this.sx, sy: this.sy, n: this.n, value: this.value, decl: this.decl }; }
}
