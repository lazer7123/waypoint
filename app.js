// Waypoint: drop pins where you are and see them floating in place on the glasses display,
// even floors below you. Compass + GPS (from the phone) + step counting + floors.
import * as G from "./geo.js";
import { declination } from "./wmm2025.js";

const W = 600, H = 600, CX = W / 2, CY = H / 2;
const STORE = "waypoint.v1";
const NAMES = ["Pin", "Car", "Door", "Elevator", "Stairs", "Room", "Stage", "Exit", "Meet up", "Camp", "Restroom", "Food"];
const DEFAULTS = {
  units: "ft",          // ft | m
  heightMode: "floors", // floors | altitude (the phone's altitude reading)
  floorH: 3.2,          // metres per floor
  steps: true,          // count steps to track you indoors / between GPS fixes
  stepLen: 0.7,         // metres per step
  stepSens: 1.2,        // m/s2 bounce that counts as a step
  gps: "auto",          // auto (steps + GPS) | always (GPS pulls hard: outdoors) | off (steps only)
  fov: 14,              // degrees across the display (for lining pins up with the world)
  offset: 0,            // extra heading trim, degrees
  north: "magnetic",    // what the glasses' compass reports: magnetic (we add the local declination) | true
  autoAlign: true,      // learn the exact heading correction from GPS while you walk
};
const ORB_H = 1.6;      // orbs hover at eye height above the floor they were dropped on (metres)
const ARRIVE_M = 1.2;   // this close (same floor) counts as standing on the pin
const AHEAD = 1.52;     // "5 ft ahead" (metres)
const CHOICES = { units: ["ft", "m"], heightMode: ["floors", "altitude"], gps: ["auto", "always", "off"], north: ["magnetic", "true"] };
const LIMITS = { floorH: [2.4, 6], stepLen: [0.4, 1.1], stepSens: [0.3, 4], fov: [5, 60], offset: [-180, 180] };
const CYAN = "#33ddff", GREEN = "#7fff9f", WHITE = "#ffffff", DIM = "#8a8a8a", RED = "#ff6a5a";

// ---------- saved state ----------
const S = { pins: [], settings: { ...DEFAULTS }, cal: null, floor: 1, work: null, pos: { e: 0, n: 0 }, target: null, mapZoom: 18, decl: null, align: null };
// ---------- live state ----------
const RT = {
  screen: "start", list: null, stack: [],
  raw: null, absolute: false, samples: [],
  head: new G.AngleAvg(0.3), headSlow: new G.AngleAvg(0.03), pitch: null, aligner: new G.HeadingAligner(), courseFrom: null, courseHead: null,
  orientCount: 0, orientRate: 0,
  pose: null, walkHeading: null,
  steps: new G.StepDetector(), filter: new G.PosTracker(), accel: NaN,
  fix: null, fixes: 0, gpsConfirmed: false, lastStepT: -1e9, lastCand: -1e9, streak: 0, walkSteps: 0, yawRate: 0, prevH: null, prevHT: 0,
  sawAbs: false, lastOrientT: -1e9, decl: 0, declAt: null, home: "ar", hist: 0, pendingGo: 0, navigating: false, frameErr: null, alt: null, geoErr: null, geoStarted: false,
  toastUntil: 0, confirm: null, calStep: 0, calCaps: [], calMsg: "",
};

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const panel = document.getElementById("panel");
const titleEl = document.getElementById("title");
const listEl = document.getElementById("list");
const hintEl = document.getElementById("hint");
const toastEl = document.getElementById("toast");
const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
canvas.width = W * dpr; canvas.height = H * dpr;
ctx.scale(dpr, dpr);

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE) || "null");
    if (j) {
      S.pins = Array.isArray(j.pins) ? j.pins.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p, i) => ({
        ...p,
        id: typeof p.id === "string" && p.id ? p.id : `p${i}${Date.now().toString(36)}`,
        name: typeof p.name === "string" && p.name ? p.name.slice(0, 40) : `Pin ${i + 1}`,
        floor: Number.isFinite(p.floor) ? G.clamp(Math.round(p.floor), -9, 200) : 1,
        t: Number.isFinite(p.t) ? p.t : Date.now(),
        alt: Number.isFinite(p.alt) ? p.alt : null,
        acc: Number.isFinite(p.acc) ? p.acc : 50,
      })) : [];
      S.settings = cleanSettings(j.settings);
      S.cal = validCal(j.cal) ? j.cal : null;
      S.floor = Number.isFinite(j.floor) ? G.clamp(Math.round(j.floor), -9, 200) : 1;
      S.work = j.work && Number.isFinite(j.work.lat) && Number.isFinite(j.work.lon) ? { lat: j.work.lat, lon: j.work.lon, ...(j.work.prov ? { prov: true } : {}) } : null;
      S.pos = j.pos && Number.isFinite(j.pos.e) && Number.isFinite(j.pos.n) ? j.pos : { e: 0, n: 0 };
      S.posT = Number.isFinite(j.posT) ? j.posT : 0;
      S.target = j.target ?? null;
      S.mapZoom = Number.isFinite(j.mapZoom) ? G.clamp(j.mapZoom, 12, 19) : 18;
      const a = j.align;
      if (a && [a.sx, a.sy, a.n].every(Number.isFinite) && a.n >= 0 && a.n <= 40 && Math.hypot(a.sx, a.sy) <= a.n + 1e-6) {
        RT.aligner = new G.HeadingAligner({ sx: a.sx, sy: a.sy, n: a.n, value: Number.isFinite(a.value) ? a.value : null });
        if (Number.isFinite(a.decl)) RT.aligner.decl = a.decl;
      }
      if (j.decl && [j.decl.v, j.decl.lat, j.decl.lon].every(Number.isFinite)) {
        // Last known declination: correct magnetic north right away, before any GPS fix.
        S.decl = j.decl; RT.decl = j.decl.v; RT.declAt = { lat: j.decl.lat, lon: j.decl.lon, stale: true };
      }
    }
  } catch { /* storage unavailable: start fresh */ }
  const f = RT.filter;
  f.e = S.pos.e; f.n = S.pos.n;
  if (S.work && !S.work.prov) {
    // Last known spot. If it's more than a couple of minutes old you may be anywhere now: trust the
    // first GPS fix of this session completely, however rough it is.
    f.has = true;
    const age = Date.now() - (S.posT || 0);
    f.P = age < 120000 ? 30 * 30 : 1e8;
    // A pin re-sync's GPS correction still holds if it's recent (GPS errors change over the day).
    if (Number.isFinite(S.pos.lastAcc)) f.lastAcc = G.clamp(S.pos.lastAcc, 3, 150);
    const b = S.pos.bias;
    if (age < 600000 && b && Number.isFinite(b.e) && Number.isFinite(b.n) && Number.isFinite(S.pos.since)) {
      f.bias = { e: b.e, n: b.n }; f.sinceSync = Math.max(0, S.pos.since);
    }
  }
}
function cleanSettings(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(DEFAULTS)) {
    const v = raw[k];
    if (CHOICES[k]) { if (CHOICES[k].includes(v)) out[k] = v; }
    else if (typeof DEFAULTS[k] === "boolean") { if (typeof v === "boolean") out[k] = v; }
    else if (Number.isFinite(v)) out[k] = G.clamp(v, ...LIMITS[k]);
  }
  return out;
}
function validCal(c) {
  return !!c && c.kind === "simple" && (c.hSign === 1 || c.hSign === -1) && (c.pSign === 1 || c.pSign === -1)
    && (c.pAxis === "b" || c.pAxis === "g") && Number.isFinite(c.pZero);
}

function save() {
  const f = RT.filter;
  S.pos = { e: f.e, n: f.n, lastAcc: f.lastAcc, ...(f.biasFade > 0 ? { bias: f.bias, since: f.sinceSync } : {}) };
  if (RT.gpsConfirmed) S.posT = Date.now(); // only a position GPS has confirmed this session counts as fresh
  S.align = RT.aligner.toJSON();
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* ignore */ }
}
let posSaveAt = 0;
function savePosSoon() { const t = Date.now(); if (t - posSaveAt > 5000) { posSaveAt = t; save(); } }

// ---------- sensors ----------

function onOrient(ev, isAbs) {
  let a = ev.alpha;
  const b = ev.beta, g = ev.gamma;
  if (typeof ev.webkitCompassHeading === "number") { a = G.wrap360(-ev.webkitCompassHeading); isAbs = true; }
  if (a == null || b == null || g == null) return;
  const now = performance.now();
  const abs = !!(isAbs || ev.absolute);
  // Once a north-locked (absolute) stream has been seen, never mix in the relative one: its zero is arbitrary.
  if (!abs && RT.sawAbs) return;
  if (abs && !RT.sawAbs) { RT.sawAbs = true; RT.head = new G.AngleAvg(0.3); RT.headSlow = new G.AngleAvg(0.03); RT.samples = []; }
  RT.absolute = abs;
  RT.lastOrientT = now;
  RT.raw = { a, b, g };
  RT.orientCount++;
  RT.samples.push({ a, b, g, t: now });
  while (RT.samples.length && now - RT.samples[0].t > 1000) RT.samples.shift();
  if (S.cal) {
    const pose = G.readPose(RT.raw, S.cal);
    RT.pitch = RT.pitch == null ? pose.pitch : RT.pitch + (pose.pitch - RT.pitch) * 0.3;
    // Looking steeply up/down, a compass heading gets unreliable: hold the last one.
    if (Math.abs(pose.pitch) < 70 || RT.head.value == null) {
      RT.head.push(pose.heading);
      if (Math.abs(pose.pitch) < 30) {
        RT.headSlow.push(pose.heading);
        const ch = RT.courseHead; // heading averaged over the current GPS stretch (for auto-align)
        if (ch) { ch.c += Math.cos(pose.heading * G.D2R); ch.s += Math.sin(pose.heading * G.D2R); ch.n++; }
      }
    }
  }
}
window.addEventListener("deviceorientationabsolute", (e) => onOrient(e, true));
window.addEventListener("deviceorientation", (e) => onOrient(e, false));

window.addEventListener("devicemotion", (ev) => {
  const a = ev.accelerationIncludingGravity || ev.acceleration;
  if (!a || a.x == null) return;
  const mag = Math.hypot(a.x, a.y || 0, a.z || 0);
  RT.accel = mag;
  RT.motionSeen = true;
  const now = performance.now();
  if (!RT.steps.push(mag, now, S.settings.stepSens)) return;
  // Any bounce: GPS read before it no longer counts as "standing here". (With step counting off,
  // bounces are the only sign of how far you've walked from a re-sync.)
  RT.filter.moving(S.settings.steps ? 0 : S.settings.stepLen);
  // A nod or head turn also bounces the sensor. Count it as walking only with a steady rhythm
  // (3+ bounces 0.3-1.2 s apart) and while not whipping your head around.
  const gap = now - RT.lastCand;
  RT.lastCand = now;
  if (RT.yawRate > 90) RT.streak = 0;
  else if (gap >= 300 && gap <= 1200) RT.streak++;
  else RT.streak = 1;
  if (RT.streak < 3) return;
  const n = RT.streak === 3 ? 3 : 1; // the first two bounces of a walk count too
  RT.lastStepT = now;
  RT.walkSteps += n;
  if (S.settings.steps && RT.walkHeading != null) {
    predict();
    for (let i = 0; i < n; i++) RT.filter.step(S.settings.stepLen, RT.walkHeading);
    afterMove();
  }
});

function startGeo() {
  if (RT.geoStarted) return;
  RT.geoStarted = true;
  if (!navigator.geolocation) { RT.geoErr = "location not available"; return; }
  navigator.geolocation.watchPosition(onFix, (e) => { RT.geoErr = e.message || `error ${e.code}`; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function onFix(p) {
  const c = p.coords;
  RT.fixes++; RT.geoErr = null;
  RT.fix = { lat: c.latitude, lon: c.longitude, acc: Number.isFinite(c.accuracy) ? c.accuracy : 50,
             alt: c.altitude, altAcc: c.altitudeAccuracy, course: c.heading, speed: c.speed, t: Date.now() };
  learnAlignment(RT.fix);
  if (Number.isFinite(c.altitude)) RT.alt = RT.alt == null ? c.altitude : RT.alt + (c.altitude - RT.alt) * 0.3;
  const f = RT.filter, mode = S.settings.gps, acc = RT.fix.acc;
  if (mode === "off" && f.has) {
    // Steps only, but still tie steps-only pins to the map the first time GPS is heard.
    if (S.work && S.work.prov) { anchor(RT.fix); afterMove(); }
    return;
  }
  // Every reading counts, even indoors at ±30-60 m: from moment to moment it's much steadier than
  // that, so it keeps pulling you back and step errors can't pile up. How hard it pulls follows how
  // unsure we are (see PosTracker).
  anchor(RT.fix);
  const z = G.enu(S.work.lat, S.work.lon, RT.fix.lat, RT.fix.lon);
  predict();
  if (f.fix(z.e, z.n, acc, mode === "always") === "skip") return;
  RT.gpsConfirmed = true;
  afterMove();
}

/**
 * While you walk outdoors, GPS knows which way you're going. You mostly look where you walk, so the
 * steady difference between that and the glasses' heading is the exact correction (magnetic north,
 * sensor quirks, anything). Only uses moments that look like steady walking with your head level.
 */
function learnAlignment(fix) {
  if (!S.settings.autoAlign || !S.cal) return;
  const now = performance.now();
  // Only while really walking: a steady step rhythm right now (GPS drift while standing still
  // can look like movement, and would teach a wrong correction).
  const walking = RT.streak >= 3 && now - RT.lastStepT < 2000;
  const from = RT.courseFrom;
  let course = null, head = null;
  if (walking && Number.isFinite(fix.course) && fix.course >= 0 && Number.isFinite(fix.speed) && fix.speed >= 0.6 && fix.acc <= 15) {
    course = fix.course;
    head = RT.headSlow.steadiness >= 0.9 ? RT.headSlow.value : null;
  } else if (from && walking && fix.acc <= 12 && fix.t - from.t <= 45000) {
    const d = G.enu(from.lat, from.lon, fix.lat, fix.lon);
    const dist = Math.hypot(d.e, d.n), speed = dist / Math.max((fix.t - from.t) / 1000, 0.1);
    if (dist < Math.max(6, from.acc + fix.acc)) return; // not far enough yet to trust the direction
    if (speed >= 0.5 && speed <= 2.5) {
      course = G.bearingOf(d.e, d.n);
      // compare with where your head pointed over the same stretch, not just the last moment
      const h = RT.courseHead;
      if (h && h.n >= 10 && Math.hypot(h.c, h.s) / h.n >= 0.9) head = G.wrap360(Math.atan2(h.s, h.c) * G.R2D);
    }
  }
  // start a new stretch from here
  RT.courseFrom = fix.acc <= 12 && walking ? fix : null;
  RT.courseHead = RT.courseFrom ? { c: 0, s: 0, n: 0 } : null;
  if (course == null || head == null) return;
  if (RT.pitch == null || Math.abs(RT.pitch) > 25 || RT.yawRate > 30) return;
  const before = RT.aligner.ready;
  if (RT.aligner.add(course, head)) {
    RT.aligner.decl = RT.decl; // remember the local magnetic declination it was learned with
    if (!before) toast(`Heading aligned (${fmtSigned(RT.aligner.value)})`);
    savePosSoon();
  }
}

/** Degrees to add to the glasses' heading to get true north. */
function headingCorrection() {
  const s = S.settings;
  // A learned correction includes the magnetic declination where it was learned; adjust it if you've
  // travelled somewhere the declination differs.
  const shift = s.north === "magnetic" && Number.isFinite(RT.aligner.decl) ? RT.decl - RT.aligner.decl : 0;
  const learned = s.autoAlign && RT.aligner.ready ? RT.aligner.value + shift : null;
  const base = learned !== null ? learned : s.north === "magnetic" ? RT.decl : 0;
  return base + s.offset;
}

/** Grow position doubt with time. Walking with steps counted: steps carry the movement. Head
 *  perfectly still: standing, very little doubt (orbs stay put). Bouncing without a clear step
 *  rhythm (shuffling) or no motion sensor: more. Step tracking off: you could be walking. */
let lastPredict = performance.now();
function predict() {
  const now = performance.now();
  const q = !S.settings.steps ? 3 : now - RT.lastStepT < 3000 ? 0.05
    : !RT.motionSeen ? 0.5 : now - RT.lastCand < 2500 ? 1 : 0.05;
  RT.filter.predict((now - lastPredict) / 1000, q);
  lastPredict = now;
}

/** Tie our local metres to the map on the first real fix (moving pins dropped before it along). */
function anchor(fix) {
  if (S.work && !S.work.prov) return;
  const f = RT.filter;
  const W0 = G.offsetLatLon(fix.lat, fix.lon, -f.e, -f.n);
  if (S.work && S.work.prov) {
    for (const p of S.pins) {
      if (!p.prov) continue;
      const r = G.enu(0, 0, p.lat, p.lon);
      const ll = G.offsetLatLon(W0.lat, W0.lon, r.e, r.n);
      p.lat = ll.lat; p.lon = ll.lon; p.acc = fix.acc; delete p.prov;
    }
  }
  S.work = { lat: W0.lat, lon: W0.lon };
  save();
}

function afterMove() {
  const f = RT.filter;
  if (S.work && !S.work.prov && Math.hypot(f.e, f.n) > 2000) {
    const ll = here();
    f.shift(f.e, f.n);
    S.work = { lat: ll.lat, lon: ll.lon };
    save();
  }
  savePosSoon();
}

function here() {
  if (!S.work) return null;
  return G.offsetLatLon(S.work.lat, S.work.lon, RT.filter.e, RT.filter.n);
}

setInterval(() => {
  RT.orientRate = RT.orientCount; RT.orientCount = 0;
}, 1000);
document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
window.addEventListener("pagehide", save);

// ---------- pins ----------

function relOf(pin) {
  const me = here();
  if (!me) return null;
  const r = G.enu(me.lat, me.lon, pin.lat, pin.lon);
  let up;
  if (S.settings.heightMode === "altitude" && Number.isFinite(pin.alt) && RT.alt != null) up = pin.alt - RT.alt - G.EYE_HEIGHT;
  else up = (pin.floor - S.floor) * S.settings.floorH - G.EYE_HEIGHT;
  return { e: r.e, n: r.n, up, flat: Math.hypot(r.e, r.n) };
}

function levelText(pin, rel) {
  if (S.settings.heightMode === "altitude" && Number.isFinite(pin.alt) && RT.alt != null) {
    const dz = rel.up + G.EYE_HEIGHT;
    if (Math.abs(dz) < 2) return "";
    return `${dz > 0 ? "↑" : "↓"}${G.fmtDist(Math.abs(dz), S.settings.units)}`;
  }
  const d = pin.floor - S.floor;
  if (!d) return "";
  return `${d > 0 ? "↑" : "↓"}${Math.abs(d)} floor${Math.abs(d) === 1 ? "" : "s"}`;
}

function uniqueName(base) {
  const used = new Set(S.pins.map((p) => p.name));
  if (base === "Pin") { let i = 1; while (used.has(`Pin ${i}`)) i++; return `Pin ${i}`; }
  if (!used.has(base)) return base;
  let i = 2; while (used.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function dropPin(name, ahead = 0) {
  if (ahead && !RT.pose) { toast("No heading yet — can't place it ahead"); return; }
  if (!S.work) S.work = { lat: 0, lon: 0, prov: true }; // no fix yet: steps only, tied to the map later
  let me = here();
  if (ahead) {
    const h = RT.pose.heading * G.D2R;
    me = G.offsetLatLon(me.lat, me.lon, ahead * Math.sin(h), ahead * Math.cos(h));
  }
  const pin = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, lat: me.lat, lon: me.lon,
                floor: S.floor, alt: RT.alt, acc: RT.filter.acc, t: Date.now() };
  if (S.work.prov) pin.prov = true;
  S.pins.push(pin);
  save();
  toast(`Dropped ${name} · floor ${S.floor}${pin.prov ? " · no GPS yet, using steps" : RT.filter.acc > 25 ? " · rough spot" : ""}`);
}

function movePinHere(pin) {
  if (!S.work) S.work = { lat: 0, lon: 0, prov: true };
  const me = here();
  pin.lat = me.lat; pin.lon = me.lon; pin.floor = S.floor; pin.alt = RT.alt; pin.acc = RT.filter.acc; pin.t = Date.now();
  if (S.work.prov) pin.prov = true; else delete pin.prov;
  save();
  toast(`Moved ${pin.name} here`);
}

/** "I'm at this pin": you know exactly where you are, so jump there and clear all drift. */
function resyncAt(pin) {
  if (!S.work || !S.pins.includes(pin)) return;
  const z = G.enu(S.work.lat, S.work.lon, pin.lat, pin.lon);
  RT.filter.resync(z.e, z.n);
  S.floor = pin.floor;
  save();
  const b = RT.filter.bias, off = b ? Math.hypot(b.e, b.n) : 0;
  const note = b ? (off >= 3 ? ` · GPS was ${G.fmtDist(off, S.settings.units)} off here` : "") : !S.work.prov && S.settings.gps !== "off" ? " · hold still a few seconds" : "";
  toast(`Re-synced at ${pin.name} · floor ${pin.floor}${note}`, 3000);
}

/** The pin you're probably standing at (for the quick re-sync), if one is close. */
function nearPin() {
  let best = null;
  for (const p of S.pins) {
    const rel = relOf(p);
    if (!rel) continue;
    const d = rel.flat + Math.abs(p.floor - S.floor) * 3;
    if (d <= Math.max(8, Math.min(RT.filter.acc * 1.5, 20)) && (!best || d < best.d)) best = { p, d };
  }
  return best ? best.p : null;
}

function deletePin(pin) {
  S.pins = S.pins.filter((p) => p !== pin);
  if (S.target === pin.id) S.target = null;
  save();
  toast(`Deleted ${pin.name}`);
}

function targetPin() { return S.pins.find((p) => p.id === S.target) || null; }

function cycleTarget(dir) {
  if (!S.pins.length) { toast("No pins yet — pinch, then Drop pin here"); return; }
  const ids = [null, ...pinsByDistance().map((p) => p.id)];
  const i = ids.indexOf(S.target);
  S.target = ids[(i + dir + ids.length) % ids.length];
  save();
  toast(S.target ? `Guiding to ${targetPin().name}` : "Guiding off");
}

function pinsByDistance() {
  return [...S.pins].sort((a, b) => (relOf(a)?.flat ?? 0) - (relOf(b)?.flat ?? 0));
}

// ---------- toast ----------

function toast(text, ms = 2200) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  RT.toastUntil = performance.now() + ms;
}

// ---------- menus ----------
// Menus are real buttons. Swipes move focus between them; a pinch presses the focused one
// (the glasses send Enter to the focused element, which a <button> turns into a click).
// "Back" is the glasses' own back gesture (history.back or Escape) — no in-app Back buttons.

function openList(build) {
  if (RT.screen === "list") RT.stack.push(RT.list);
  RT.list = { build, sel: 0 };
  RT.confirm = null;
  go("list");
  renderList();
  syncHistory();
}
function closeAll() {
  RT.stack = []; RT.list = null; RT.confirm = null;
  go(RT.home);
  syncHistory();
}
function stepBack() {
  RT.confirm = null;
  if (RT.screen === "list") {
    if (RT.stack.length) { RT.list = RT.stack.pop(); go("list"); renderList(); }
    else { RT.list = null; go(RT.home); }
  } else if (RT.screen === "calib" && S.cal) go(RT.home);
  else if (RT.screen === "map") { RT.home = "ar"; go("ar"); }
}
function goBack() { stepBack(); syncHistory(); }
function go(screen) {
  RT.screen = screen;
  panel.hidden = screen !== "list";
  if (screen !== "list" && panel.contains(document.activeElement)) {
    RT.navigating = true; // leaving a half-typed name box must not drop a pin
    document.activeElement.blur();
    RT.navigating = false;
  }
}

// Keep one browser-history entry per level, so the glasses' back gesture steps back one level.
function depth() {
  return (RT.home === "map" ? 1 : 0) + (RT.screen === "list" ? RT.stack.length + 1 : 0) + (RT.screen === "calib" && S.cal ? 1 : 0);
}
function syncHistory() {
  const d = depth();
  try {
    // A history.go() of ours is still in flight: catch up when it lands (see popstate).
    if (RT.pendingGo && performance.now() - RT.pendingGo < 1000) return;
    RT.pendingGo = 0;
    while (RT.hist < d) { RT.hist++; history.pushState({ wp: RT.hist }, ""); }
    if (RT.hist > d) { RT.pendingGo = performance.now(); RT.pendingTo = d; history.go(d - RT.hist); RT.hist = d; }
  } catch { /* history unavailable: Escape still works */ }
}
window.addEventListener("popstate", (e) => {
  const at = e.state && Number.isInteger(e.state.wp) ? e.state.wp : 0;
  RT.hist = at;
  if (RT.pendingGo && at === RT.pendingTo) { RT.pendingGo = 0; syncHistory(); return; } // our own step landed
  RT.pendingGo = 0;
  // The back gesture: close app levels until we're as deep as the history entry we landed on.
  let guard = 12;
  while (depth() > at && guard--) stepBack();
  syncHistory(); // also drops stale entries left over from before a reload
});
try { history.replaceState({ wp: 0 }, ""); } catch { /* ignore */ }

function renderList() {
  const L = RT.list;
  if (!L) return;
  const def = L.build();
  L.def = def;
  const n = def.items.length;
  L.sel = n ? G.clamp(L.sel, 0, n - 1) : 0;
  titleEl.textContent = def.title;
  RT.navigating = true;
  listEl.innerHTML = "";
  RT.navigating = false;
  def.items.forEach((it, i) => {
    const li = document.createElement("li");
    let el;
    if (it.input) {
      // A text box opens the glasses' voice/handwriting input when you pinch it.
      el = document.createElement("input");
      el.type = "text";
      el.placeholder = it.label;
      el.className = "item focusable input";
      el.enterKeyHint = "done";
      const submit = () => {
        const v = el.value.trim();
        if (!v || RT.navigating || document.hidden || !document.hasFocus()) return;
        el.value = "";
        ((L.def && L.def.items[i]) || it).submit(v);
      };
      // Submit when the glasses' voice/handwriting input commits (focus stays here) or on Enter —
      // never just because you swiped away from a half-finished name.
      el.addEventListener("change", submit);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && el.value.trim()) { e.preventDefault(); e.stopPropagation(); submit(); }
      });
    } else if (it.enter || it.left || it.right) {
      el = document.createElement("button");
      el.type = "button";
      el.className = "item focusable";
      if (it.danger) el.classList.add("danger");
      el.innerHTML = '<span class="lbl"></span><span class="val"></span>';
      el.addEventListener("click", () => {
        L.sel = i;
        const cur = (L.def && L.def.items[i]) || it; // the item as it is now (e.g. "Pinch again to delete")
        if (cur.enter) cur.enter();
        else if (cur.right) { cur.right(); refreshValues(); } // pinching a setting steps it too
      });
    } else {
      el = document.createElement("div");
      el.className = "item info";
      el.innerHTML = '<span class="lbl"></span><span class="val"></span>';
    }
    el.dataset.i = i;
    el.addEventListener("focus", () => {
      if (L.sel !== i) { L.sel = i; if (RT.confirm) { RT.confirm = null; refreshValues(); } }
      el.scrollIntoView({ block: "nearest" });
    });
    li.append(el);
    listEl.append(li);
  });
  refreshValues();
  focusSel();
}

/** Update labels/values in place (keeps focus), e.g. live sensor readings or a changed setting. */
function refreshValues() {
  const L = RT.list;
  if (!L || !L.def) return;
  const def = L.build();
  if (def.items.length !== L.def.items.length) { L.def = def; renderList(); return; }
  L.def = def;
  titleEl.textContent = def.title;
  hintEl.textContent = typeof def.hint === "function" ? def.hint() : def.hint || "";
  def.items.forEach((it, i) => {
    const el = listEl.querySelector(`[data-i="${i}"]`);
    if (!el || it.input) return;
    const adjustable = it.left || it.right;
    el.querySelector(".lbl").textContent = it.label;
    el.querySelector(".val").textContent = it.value ? (adjustable ? `‹ ${it.value()} ›` : it.value()) : "";
    el.classList.toggle("danger", !!it.danger);
  });
}

function focusSel() {
  const el = listEl.querySelector(`[data-i="${RT.list.sel}"]`);
  const target = el && el.matches(".focusable") ? el : listEl.querySelector(".focusable");
  if (target) target.focus({ preventScroll: false });
}

function moveFocus(dir) {
  const items = [...listEl.querySelectorAll(".focusable")];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = i < 0 ? 0 : (i + dir + items.length) % items.length;
  RT.navigating = true;
  items[next].focus();
  RT.navigating = false;
}

const setFloor = (f) => { S.floor = G.clamp(Math.round(f), -9, 200); save(); };
const cycle = (arr, v, dir) => arr[(arr.indexOf(v) + dir + arr.length) % arr.length];
const fmtFloorH = () => S.settings.units === "ft" ? `${(S.settings.floorH * 3.28084).toFixed(1)} ft` : `${S.settings.floorH.toFixed(1)} m`;

// Which pin to offer a quick re-sync for is decided once, when the menu opens, so items don't
// jump around under your finger while you change the floor.
function openMainMenu() { const near = nearPin(); openList(() => mainMenu(near)); }
function mainMenu(nearAtOpen) {
  const near = nearAtOpen && S.pins.includes(nearAtOpen) ? nearAtOpen : null;
  return {
    title: "Waypoint",
    items: [
      { label: "Drop pin here", enter: () => openList(() => dropMenu(0)) },
      RT.pose
        ? { label: S.settings.units === "ft" ? "Drop pin 5 ft ahead" : "Drop pin 1.5 m ahead", enter: () => openList(() => dropMenu(AHEAD)) }
        : { label: "Drop ahead (needs compass)" },
      { label: "Pins", value: () => String(S.pins.length), enter: () => openList(pinsMenu) },
      ...(near ? [{ label: `I'm at ${near.name} (re-sync)`, enter: () => { resyncAt(near); closeAll(); } }] : []),
      { label: "Floor", value: () => String(S.floor), left: () => setFloor(S.floor - 1), right: () => setFloor(S.floor + 1) },
      RT.home === "map"
        ? { label: "3D view", enter: () => { RT.home = "ar"; closeAll(); } }
        : { label: "Map", enter: () => { RT.home = "map"; closeAll(); } },
      { label: "Sensors", enter: () => openList(sensorsMenu) },
      { label: "Calibrate", enter: () => startCalib() },
      { label: "Settings", enter: () => openList(settingsMenu) },
    ],
    hint: "Swipe to move · pinch to choose · back gesture to close",
  };
}

function dropMenu(ahead) {
  const drop = (name) => { dropPin(name, ahead); closeAll(); };
  return {
    title: ahead ? `Drop ${S.settings.units === "ft" ? "5 ft" : "1.5 m"} ahead · floor ${S.floor}` : `Drop pin · floor ${S.floor}`,
    items: [
      { input: true, label: "Say or write a name…", submit: (v) => drop(uniqueName(v.slice(0, 30))) },
      ...NAMES.map((n) => ({ label: n, enter: () => drop(uniqueName(n)) })),
    ],
    hint: RT.filter.acc > 25 ? "Location is rough right now (weak GPS)" : "Pick a name, or pinch the top box to say one",
  };
}

function pinsMenu() {
  const items = pinsByDistance().map((p) => ({
    label: `${S.target === p.id ? "▸ " : ""}${p.name}`,
    value: () => { const rel = relOf(p); return `${rel ? G.fmtDist(rel.flat, S.settings.units) : "?"} · fl ${p.floor}`; },
    enter: () => openList(() => pinMenu(p)),
  }));
  if (!items.length) items.push({ label: "No pins yet" });
  return { title: "Pins", items, hint: "Nearest first" };
}

function pinMenu(pin) {
  if (!S.pins.includes(pin)) return { title: "Pin deleted", items: [{ label: "Use the back gesture" }] };
  const guiding = S.target === pin.id;
  const confirming = RT.confirm === `del:${pin.id}`;
  const when = new Date(pin.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return {
    title: pin.name,
    items: [
      guiding ? { label: "Stop guiding", enter: () => { S.target = null; save(); closeAll(); } }
              : { label: "Guide me here", enter: () => { S.target = pin.id; save(); closeAll(); toast(`Guiding to ${pin.name}`); } },
      { label: "I'm here now (re-sync)", enter: () => { resyncAt(pin); closeAll(); } },
      { label: "Move pin to where I am", enter: () => { movePinHere(pin); goBack(); } },
      { label: confirming ? "Pinch again to delete" : "Delete", danger: true,
        enter: () => { if (confirming) { deletePin(pin); goBack(); } else { RT.confirm = `del:${pin.id}`; refreshValues(); } } },
    ],
    hint: `${pin.prov ? "Not on the map yet (steps only)" : `${pin.lat.toFixed(6)}, ${pin.lon.toFixed(6)}`} · floor ${pin.floor}`
      + `${Number.isFinite(pin.alt) ? ` · alt ${S.settings.units === "ft" ? `${Math.round(pin.alt * 3.28084)} ft` : `${Math.round(pin.alt)} m`}` : ""}`
      + `${pin.prov ? "" : ` · ±${G.fmtDist(pin.acc, S.settings.units)}`} · ${when}`,
  };
}

function settingsMenu() {
  const s = S.settings;
  const set = (k, v) => { s[k] = v; save(); };
  const confirming = RT.confirm === "delall";
  const flip = (k, a, b) => () => set(k, s[k] === a ? b : a);
  return {
    title: "Settings",
    items: [
      { label: "Units", value: () => (s.units === "ft" ? "feet" : "metres"), left: flip("units", "ft", "m"), right: flip("units", "ft", "m") },
      { label: "Height from", value: () => (s.heightMode === "floors" ? "floors" : "phone altitude"), left: flip("heightMode", "floors", "altitude"), right: flip("heightMode", "floors", "altitude") },
      { label: "Floor height", value: fmtFloorH, left: () => set("floorH", G.clamp(+(s.floorH - 0.1).toFixed(1), 2.4, 6)), right: () => set("floorH", G.clamp(+(s.floorH + 0.1).toFixed(1), 2.4, 6)) },
      { label: "Step tracking", value: () => (s.steps ? "on" : "off"), left: () => set("steps", !s.steps), right: () => set("steps", !s.steps) },
      { label: "Step length", value: () => (s.units === "ft" ? `${(s.stepLen * 3.28084).toFixed(1)} ft` : `${s.stepLen.toFixed(2)} m`), left: () => set("stepLen", G.clamp(+(s.stepLen - 0.05).toFixed(2), 0.4, 1.1)), right: () => set("stepLen", G.clamp(+(s.stepLen + 0.05).toFixed(2), 0.4, 1.1)) },
      { label: "Step sensitivity", value: () => s.stepSens.toFixed(1), left: () => set("stepSens", G.clamp(+(s.stepSens - 0.1).toFixed(1), 0.3, 4)), right: () => set("stepSens", G.clamp(+(s.stepSens + 0.1).toFixed(1), 0.3, 4)) },
      { label: "GPS", value: () => ({ auto: "steps + GPS", always: "strong (outdoors)", off: "off (steps only)" })[s.gps], left: () => set("gps", cycle(["auto", "always", "off"], s.gps, -1)), right: () => set("gps", cycle(["auto", "always", "off"], s.gps, 1)) },
      { label: "View width", value: () => `${s.fov}°`, left: () => set("fov", G.clamp(s.fov - 1, 5, 60)), right: () => set("fov", G.clamp(s.fov + 1, 5, 60)) },
      { label: "Compass north", value: () => (s.north === "magnetic" ? `magnetic (fix ${fmtDecl()})` : "true"), left: flip("north", "magnetic", "true"), right: flip("north", "magnetic", "true") },
      { label: "Auto-align (walking)", value: () => (s.autoAlign ? (RT.aligner.ready ? `on · ${fmtAlign()}` : "on · learning") : "off"), left: () => set("autoAlign", !s.autoAlign), right: () => set("autoAlign", !s.autoAlign) },
      { label: "Reset alignment", enter: () => { RT.aligner = new G.HeadingAligner(); save(); toast("Alignment reset — walk outside to relearn"); refreshValues(); } },
      { label: "Heading trim", value: () => `${s.offset > 0 ? "+" : ""}${s.offset}°`, left: () => set("offset", G.clamp(s.offset - 1, -180, 180)), right: () => set("offset", G.clamp(s.offset + 1, -180, 180)) },
      { label: confirming ? "Pinch again to delete ALL pins" : "Delete all pins", danger: true,
        enter: () => { if (confirming) { S.pins = []; S.target = null; RT.confirm = null; save(); toast("All pins deleted"); } else RT.confirm = "delall"; refreshValues(); } },
    ],
    hint: "Swipe sideways (or pinch) to change",
  };
}

function sensorsMenu() {
  const s = S.settings, fix = RT.fix, f = RT.filter;
  const age = fix ? Math.round((Date.now() - fix.t) / 1000) : null;
  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "–");
  const setOff = (d) => { s.offset = G.clamp(s.offset + d, -180, 180); save(); };
  return {
    live: true,
    title: "Sensors",
    items: [
      { label: "Heading", value: () => (RT.pose ? `${Math.round(RT.pose.heading)}° ${G.cardinal(RT.pose.heading)} (trim ${s.offset > 0 ? "+" : ""}${s.offset}°)` : "calibrate first"), left: () => setOff(-1), right: () => setOff(1) },
      { label: "Correction", value: () => `${fmtSigned(headingCorrection())} (${s.autoAlign && RT.aligner.ready ? "learned walking" : s.north === "magnetic" ? "magnetic north " + fmtDecl() : "none"})` },
      { label: "Pitch", value: () => (RT.pose ? `${Math.round(RT.pose.pitch) || 0}°` : "–") },
      { label: "Compass", value: () => (RT.raw ? `${RT.absolute ? "absolute" : "relative!"} · ${RT.orientRate}/s` : "no data") },
      { label: "Raw α β γ", value: () => (RT.raw ? `${fmt(RT.raw.a)} ${fmt(RT.raw.b)} ${fmt(RT.raw.g)}` : "–") },
      { label: "Motion", value: () => `${fmt(RT.accel, 1)} m/s² · ${RT.walkSteps} steps (${RT.steps.count} bounces)` },
      { label: "GPS", value: () => (fix ? `±${fmt(fix.acc)} m · ${age}s ago · ${RT.fixes}` : RT.geoErr || "waiting") },
      { label: "Altitude", value: () => (fix && Number.isFinite(fix.alt) ? `${fmt(fix.alt, 1)} m ±${fmt(fix.altAcc)} (avg ${fmt(RT.alt, 1)})` : "none") },
      { label: "My position", value: () => (S.work ? `±${fmt(f.acc)} m${S.work.prov ? " (steps only)" : ""}` : "unknown") },
    ],
    hint: "Heading row: swipe sideways to match your iPhone Compass",
  };
}

// ---------- calibration ----------

const CAL_STEPS = [
  "Look straight ahead at the horizon, head level. Then pinch.",
  "Now turn your head to the RIGHT, about a quarter turn. Then pinch.",
  "Face forward again and look DOWN at your feet. Then pinch.",
];

function startCalib() {
  RT.stack = []; RT.list = null;
  RT.calStep = 0; RT.calCaps = []; RT.calMsg = "";
  go("calib");
  syncHistory();
}

function captureCal() {
  const now = performance.now();
  const recent = RT.samples.filter((s) => now - s.t < 400);
  if (!recent.length) { RT.calMsg = "No compass data yet — wait a moment and try again"; return; }
  RT.calCaps.push(recent.map(({ a, b, g }) => ({ a, b, g })));
  RT.calMsg = "";
  RT.calStep++;
  if (RT.calStep < 3) return;
  const [level, right, down] = RT.calCaps;
  const cal = G.solveSimpleCal(level, right, down);
  if (!cal.ok) {
    RT.calCaps = []; RT.calStep = 0;
    RT.calMsg = cal.why === "down" ? "Didn't see you look down — let's go again" : "Didn't see you turn right — let's go again";
    return;
  }
  const flipped = S.cal && S.cal.hSign !== cal.hSign;
  S.cal = { kind: "simple", hSign: cal.hSign, pAxis: cal.pAxis, pSign: cal.pSign, pZero: cal.pZero };
  if (flipped) RT.aligner = new G.HeadingAligner(); // a learned correction from the old setup no longer applies
  RT.head = new G.AngleAvg(0.3); RT.headSlow = new G.AngleAvg(0.03); RT.pitch = null;
  save();
  go(RT.home);
  syncHistory();
  toast(cal.pAxis === "g" ? "Calibrated — unusual sensor layout, heading may shift as you look up/down" : "Calibrated", 3500);
}

// ---------- input ----------

document.addEventListener("keydown", (e) => {
  const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "ok", Escape: "back" };
  const k = map[e.key];
  if (!k) return;
  if (RT.screen === "list") {
    const inField = document.activeElement && document.activeElement.tagName === "INPUT";
    if (k === "ok") {
      if (e.repeat) { e.preventDefault(); return; } // a held pinch presses once
      // The focused button handles the pinch itself (Enter → click). Only step in if nothing is focused.
      if (!panel.contains(document.activeElement)) { e.preventDefault(); focusSel(); }
      return;
    }
    if (inField && (k === "left" || k === "right")) return; // let the text box have its cursor keys
    e.preventDefault();
    if (k === "back") { goBack(); return; }
    if (k === "up" || k === "down") { moveFocus(k === "up" ? -1 : 1); return; }
    const it = RT.list?.def?.items[RT.list.sel];
    if (it && it[k]) { it[k](); refreshValues(); }
    return;
  }
  e.preventDefault();
  if (e.repeat && k === "ok") return;
  handleKey(k);
});

/** Keys on the full-screen views (start, 3D view, map, calibration). */
function handleKey(k) {
  switch (RT.screen) {
    case "start":
      if (k === "ok") begin();
      break;
    case "ar":
      if (k === "ok") openMainMenu();
      else if (k === "left") cycleTarget(-1);
      else if (k === "right") cycleTarget(1);
      break;
    case "map":
      if (k === "up") { S.mapZoom = Math.min(19, S.mapZoom + 1); save(); }
      else if (k === "down") { S.mapZoom = Math.max(12, S.mapZoom - 1); save(); }
      else if (k === "left") cycleTarget(-1);
      else if (k === "right") cycleTarget(1);
      else if (k === "back") goBack();
      else if (k === "ok") openMainMenu();
      break;
    case "calib":
      if (k === "ok") captureCal();
      else if (k === "back") goBack();
      break;
  }
}

async function begin() {
  // Both permission requests must start inside the pinch (a user gesture).
  const asks = [];
  try { if (window.DeviceOrientationEvent?.requestPermission) asks.push(DeviceOrientationEvent.requestPermission()); } catch { /* ignore */ }
  try { if (window.DeviceMotionEvent?.requestPermission) asks.push(DeviceMotionEvent.requestPermission()); } catch { /* ignore */ }
  startGeo();
  await Promise.allSettled(asks);
  if (!S.cal) startCalib(); else { go(RT.home); syncHistory(); }
}

// ---------- drawing ----------

function text(str, x, y, { size = 22, color = WHITE, align = "center", weight = 600, base = "middle" } = {}) {
  ctx.font = `${weight} ${size}px system-ui, -apple-system, Roboto, sans-serif`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
  ctx.fillText(str, x, y);
}

function wrapText(str, x, y, maxW, lineH, opts) {
  ctx.font = `${opts.weight || 600} ${opts.size || 22}px system-ui, -apple-system, Roboto, sans-serif`;
  const words = str.split(" ");
  let line = "", lines = [];
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => text(l, x, y + i * lineH, opts));
  return lines.length;
}

/** Magnetic declination here (recomputed when you've moved ~5 km). */
function updateDecl() {
  const me = S.work && !S.work.prov ? here() : RT.fix;
  if (!me) return;
  if (RT.declAt && !RT.declAt.stale && Math.abs(me.lat - RT.declAt.lat) < 0.05 && Math.abs(me.lon - RT.declAt.lon) < 0.05) return;
  const d = new Date();
  const year = d.getFullYear() + (d.getMonth() + d.getDate() / 31) / 12;
  const v = declination(me.lat, me.lon, year);
  if (Number.isFinite(v)) {
    RT.decl = v; RT.declAt = { lat: me.lat, lon: me.lon };
    S.decl = { v, lat: me.lat, lon: me.lon };
    save();
  }
}
function fmtSigned(v) { return `${v >= 0 ? "+" : ""}${v.toFixed(1)}°`; }
function fmtAlign() { return fmtSigned(RT.aligner.value); }
function fmtDecl() { return RT.declAt ? `${RT.decl >= 0 ? "+" : ""}${RT.decl.toFixed(1)}°` : "needs GPS"; }

let lastDraw = 0;
/** Head pose for this moment (also needed while a menu is open: steps and "drop ahead" use it). */
function updatePose() {
  updateDecl();
  RT.pose = null;
  if (!S.cal || RT.head.value == null || RT.pitch == null) return;
  const raw = RT.head.value;
  RT.pose = { heading: G.wrap360(raw + headingCorrection()), pitch: RT.pitch };
  const now = performance.now();
  if (RT.prevH != null && now > RT.prevHT) { // turn speed from the raw heading (corrections don't count)
    const rate = Math.abs(G.wrap180(raw - RT.prevH)) / ((now - RT.prevHT) / 1000);
    RT.yawRate += (Math.min(rate, 720) - RT.yawRate) * 0.3;
  }
  RT.prevH = raw; RT.prevHT = now;
  // Walking direction: follows your head, but smoothed and not while it's whipping around, so a
  // quick glance to the side doesn't send your steps that way.
  if (Math.abs(RT.pose.pitch) < 50 && RT.yawRate < 60) {
    const h = RT.pose.heading, w = RT.walkHeading;
    RT.walkHeading = w == null ? h : G.wrap360(w + G.wrap180(h - w) * 0.15);
  }
}

function frame(now) {
  requestAnimationFrame(frame); // keep going even if something below throws
  if (now - lastDraw < 32) return; // ~30 fps is plenty and saves battery
  lastDraw = now;
  if (!toastEl.hidden && performance.now() > RT.toastUntil) toastEl.hidden = true;
  try {
    updatePose();
    if (RT.screen === "list") return; // the menu covers the view
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (RT.screen === "start") drawStart();
    else if (RT.screen === "ar") drawAR();
    else if (RT.screen === "map") drawMap();
    else if (RT.screen === "calib") drawCalib();
    RT.frameErr = null;
  } catch (e) {
    RT.frameErr = String(e && e.message || e);
    if (typeof ctx.reset === "function") ctx.reset(); // drops any clip/save left half-done
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.filter = "none"; ctx.globalAlpha = 1;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    wrapText(`Something went wrong: ${RT.frameErr}`, CX, CY - 20, 520, 28, { size: 20, color: RED });
  }
}

function drawStart() {
  text("WAYPOINT", CX, 230, { size: 48, color: CYAN, weight: 800 });
  text("Pins that stay where you left them", CX, 290, { size: 22, color: WHITE, weight: 500 });
  text("Pinch to start", CX, 380, { size: 26, color: GREEN });
}

function drawCalib() {
  text(`Calibrate · ${Math.min(RT.calStep + 1, 3)} of 3`, CX, 70, { size: 26, color: CYAN, weight: 700 });
  wrapText(CAL_STEPS[Math.min(RT.calStep, 2)], CX, 200, 500, 36, { size: 28, color: WHITE });
  if (RT.calMsg) wrapText(RT.calMsg, CX, 380, 500, 30, { size: 22, color: RED });
  const r = RT.raw;
  text(r ? `compass ${Math.round(r.a)}° · ${RT.absolute ? "absolute" : "relative"} · ${RT.orientRate}/s` : "waiting for compass…", CX, 500, { size: 18, color: DIM, weight: 500 });
  text(S.cal ? "Back gesture to cancel" : "", CX, 540, { size: 18, color: DIM, weight: 500 });
}

function focal() { return (W / 2) / Math.tan((S.settings.fov / 2) * G.D2R); }

const RGB = { cyan: "51,221,255", green: "127,255,159" };
let labels = []; // orb labels drawn this frame, so they don't pile on top of each other

/** Place a label near (x, y), nudging it up past any label already there. */
function placeLabel(str, x, y, opts) {
  ctx.font = `${opts.weight || 600} ${opts.size || 20}px system-ui, -apple-system, Roboto, sans-serif`;
  const w = ctx.measureText(str).width, h = (opts.size || 20) + 4;
  let top = y - h / 2;
  for (let guard = 0; guard < 8; guard++) {
    const hit = labels.find((r) => Math.abs(r.x - x) < (r.w + w) / 2 && Math.abs(r.top - top) < h);
    if (!hit) break;
    top = hit.top - h;
  }
  labels.push({ x, w, top });
  text(str, x, top + h / 2, opts);
}

function drawAR() {
  if (!S.cal) { text("Needs calibrating — pinch for the menu", CX, CY, { size: 22 }); return; }
  if (!RT.pose) { text("Waiting for the compass…", CX, CY, { size: 24 }); drawStatus(); return; }
  const { heading, pitch } = RT.pose;
  const F = focal();
  const target = targetPin();
  const t = performance.now() / 1000;
  drawTape(heading);
  const items = [];
  for (const pin of S.pins) {
    const rel = relOf(pin);
    if (!rel) continue;
    const orb = { e: rel.e, n: rel.n, up: rel.up + ORB_H }; // hovering above the floor it was dropped on
    const p = G.projectHP(heading, pitch, orb, F, CX, CY);
    items.push({ pin, rel, orb, p, isT: !!target && pin.id === target.id });
  }
  items.sort((a, b) => b.p.dist - a.p.dist); // far first, near on top
  let arrived = null;
  // With a rough position, "on the pin" is a bit wider, or you'd never see it light up.
  const arriveM = G.clamp(RT.filter.acc * 0.5, ARRIVE_M, 2.5);
  for (const it of items) {
    if (it.rel.flat < arriveM && !levelText(it.pin, it.rel) && (!arrived || it.isT)) arrived = it;
  }
  labels = [];
  for (const it of items) {
    const on = it.p.z > 0.02 && it.p.x > -40 && it.p.x < W + 40 && it.p.y > 40 && it.p.y < H + 40;
    if (on) drawOrb(it, F, t);
    else if (it !== arrived && (it.isT || S.pins.length <= 3)) drawOffscreen(it, heading, pitch);
  }
  RT.arrivedName = arrived ? arrived.pin.name : null;
  if (arrived) drawArrived(arrived, t);
  drawMiniMap(heading, items);
  const focus = items.find((i) => i.isT) || (items.length ? items.reduce((a, b) => (a.rel.flat < b.rel.flat ? a : b)) : null);
  if (focus) drawGuide(focus, heading, pitch, arrived === focus);
  if (performance.now() - RT.lastOrientT > 3000) text("Compass stopped — close and reopen the app", CX, 108, { size: 17, color: RED });
  else if (!RT.absolute) text("Compass isn't locked to north", CX, 108, { size: 17, color: RED });
  drawStatus();
}

function drawTape(heading) {
  const span = 40, y = 26, pxPerDeg = 400 / (span * 2);
  ctx.strokeStyle = DIM; ctx.lineWidth = 2;
  for (let d = Math.ceil((heading - span) / 5) * 5; d <= heading + span; d += 5) {
    const x = CX + (d - heading) * pxPerDeg;
    const big = G.wrap360(d) % 45 === 0;
    ctx.beginPath(); ctx.moveTo(x, y + 12); ctx.lineTo(x, y + (big ? 2 : 7)); ctx.stroke();
    if (big) text(G.cardinal(d), x, y - 10, { size: 16, color: G.wrap360(d) === 0 ? RED : WHITE, weight: 700 });
  }
  for (const pin of S.pins) {
    const rel = relOf(pin);
    if (!rel || rel.flat < 1) continue;
    const rd = G.wrap180(G.bearingOf(rel.e, rel.n) - heading);
    const x = CX + G.clamp(rd, -span, span) * pxPerDeg;
    ctx.fillStyle = pin.id === S.target ? CYAN : GREEN;
    ctx.beginPath(); ctx.arc(x, y + 20, pin.id === S.target ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = WHITE;
  ctx.beginPath(); ctx.moveTo(CX, y + 14); ctx.lineTo(CX - 5, y + 4); ctx.lineTo(CX + 5, y + 4); ctx.closePath(); ctx.fill();
}

/** A glowing orb, sized as a ~30 cm ball would look at that distance. */
function drawOrb({ pin, rel, p, isT }, F, t) {
  const rgb = isT ? RGB.cyan : RGB.green;
  const pulse = isT ? 1 + 0.08 * Math.sin(t * 4) : 1;
  const r = G.clamp((F * 0.15) / Math.max(p.dist, 0.3), 5, 24) * pulse; // capped: up close a true-size ball would fill the display
  // A faint ring: where the pin could really be, given how sure we are of our own position.
  const spread = S.work && !S.work.prov ? RT.filter.acc : 0;
  const ring = (F * spread) / Math.max(p.dist, 0.3);
  if (spread >= 1.5 && ring > r * 3 && ring < 220 && (isT || rel.flat < 20)) {
    ctx.strokeStyle = `rgba(${rgb},0.35)`; ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.arc(p.x, p.y, ring, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
  glow(p.x, p.y, r, rgb);
  const u = S.settings.units, lvl = levelText(pin, rel);
  const label = rel.flat < 3 && !lvl ? pin.name : `${pin.name} · ${G.fmtDist(rel.flat, u)}${lvl ? " " + lvl : ""}`;
  placeLabel(label, p.x, p.y - r * 1.6 - 14, { size: isT ? 22 : 18, color: WHITE, weight: 700 });
}

function glow(x, y, r, rgb, strength = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
  g.addColorStop(0, `rgba(255,255,255,${strength})`);
  g.addColorStop(0.2, `rgba(${rgb},${strength})`);
  g.addColorStop(0.45, `rgba(${rgb},${0.35 * strength})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
}

/** Off the display: behind you → arrow at the bottom pointing down; to a side → arrow on that side;
 *  roughly ahead but above/below → arrow up/down. */
function drawOffscreen({ pin, rel, orb, p, isT }, heading, pitch) {
  const rgb = isT ? RGB.cyan : RGB.green, col = isT ? CYAN : GREEN;
  const turn = rel.flat < 0.5 ? 0 : G.wrap180(G.bearingOf(rel.e, rel.n) - heading);
  const elev = Math.atan2(orb.up, Math.max(rel.flat, 0.01)) * G.R2D;
  let x, y, ang, note;
  // Straight above/below you (e.g. floor 20 over the lobby): an up/down arrow, not a side arrow.
  const overhead = rel.flat < 0.5 || (p.z <= 0.02 && Math.abs(turn) <= 45);
  if (!overhead && Math.abs(turn) > 135) { x = CX; y = 372; ang = Math.PI / 2; note = "Behind you"; }
  else if (!overhead && !(p.z > 0.02 && p.x >= 0 && p.x <= W)) { // off to a side of the display
    const right = p.z > 0.02 ? p.x > CX : turn > 0;
    x = right ? W - 34 : 34; y = G.clamp(CY - (elev - pitch) * 6, 130, 380); ang = right ? 0 : Math.PI;
    note = `${right ? "Right" : "Left"} ${Math.round(Math.abs(turn))}°`;
  } else {
    const below = elev < pitch;
    x = G.clamp(CX + turn * 20, 60, W - 60); y = below ? 372 : 120; ang = below ? Math.PI / 2 : -Math.PI / 2;
    note = below ? "Look down" : "Look up";
  }
  const s = isT ? 22 : 12;
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  ctx.shadowColor = `rgba(${rgb},0.9)`; ctx.shadowBlur = isT ? 18 : 8;
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s, -s * 0.85); ctx.lineTo(-s * 0.35, 0); ctx.lineTo(-s, s * 0.85); ctx.closePath(); ctx.fill();
  ctx.restore();
  if (isT) {
    const ty = ang === Math.PI / 2 ? y - 40 : ang === -Math.PI / 2 ? y + 40 : y + 36;
    const tx = G.clamp(x, 90, W - 90);
    text(note, tx, ty, { size: 20, color: WHITE, weight: 700 });
  }
}

/** Standing on a pin: a glowing spot under you. */
function drawArrived({ pin, isT }, t) {
  const rgb = isT ? RGB.cyan : RGB.green;
  const r = 26 * (1 + 0.12 * Math.sin(t * 5));
  ctx.save(); ctx.translate(CX, 422); ctx.scale(1, 0.4);
  glow(0, 0, r, rgb, 0.9);
  ctx.restore();
  text(`At ${pin.name}`, CX, 446, { size: 16, color: WHITE, weight: 700 });
}

/**
 * Tilted mini map (like car navigation): you in the middle, the way you face is up, a cone for
 * what you're looking at, pins as glowing dots. Zooms so the pin you're guided to fits.
 */
const MM = { x: 112, y: 505, r: 92, tilt: 0.55 };
function drawMiniMap(heading, items) {
  const me = here();
  const target = items.find((i) => i.isT) || (items.length ? items.reduce((a, b) => (a.rel.flat < b.rel.flat ? a : b)) : null);
  const want = target ? target.rel.flat * 1.35 : 40;
  const radiusM = [15, 25, 40, 60, 100, 150, 250, 400, 800].find((r) => r >= want) || 800; // steps, so the map doesn't keep re-zooming
  const pxPerM = MM.r / radiusM;
  const h = heading * G.D2R, cosH = Math.cos(h), sinH = Math.sin(h);
  const toMap = (e, n) => { // metres east/north → mini-map pixels (before tilt)
    const fwd = e * sinH + n * cosH, rgt = e * cosH - n * sinH;
    return { x: rgt * pxPerM, y: -fwd * pxPerM };
  };
  ctx.save();
  ctx.translate(MM.x, MM.y);
  ctx.scale(1, MM.tilt);
  ctx.beginPath(); ctx.arc(0, 0, MM.r, 0, Math.PI * 2); ctx.clip();
  // street map underneath (dimmed), when we know where we are
  if (me && S.work && !S.work.prov) {
    const mpp = 1 / pxPerM;
    const z = G.clamp(Math.floor(Math.log2((156543.03392 * Math.cos(me.lat * G.D2R)) / mpp)), 12, 19);
    const tileM = (156543.03392 * Math.cos(me.lat * G.D2R)) / 2 ** z; // metres per tile pixel
    const sc = tileM / mpp;
    const c = worldPx(me.lat, me.lon, z);
    ctx.save();
    ctx.rotate(-h);
    const R = MM.r / sc + 10;
    for (let ty = Math.floor((c.y - R) / 256); ty <= Math.floor((c.y + R) / 256); ty++) {
      for (let tx = Math.floor((c.x - R) / 256); tx <= Math.floor((c.x + R) / 256); tx++) {
        const tl = tile(z, tx, ty);
        if (!tl) continue;
        ctx.globalAlpha = tl.dim ? 0.3 : 0.9;
        ctx.drawImage(tl.ready, (tx * 256 - c.x) * sc, (ty * 256 - c.y) * sc, 256 * sc, 256 * sc);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  // view cone (what's in front of you)
  const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, MM.r);
  cone.addColorStop(0, "rgba(51,221,255,0.45)");
  cone.addColorStop(1, "rgba(51,221,255,0)");
  ctx.fillStyle = cone;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, MM.r, -Math.PI / 2 - 0.35, -Math.PI / 2 + 0.35); ctx.closePath(); ctx.fill();
  // distance rings
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, MM.r * 0.5, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // rim
  ctx.save(); ctx.translate(MM.x, MM.y); ctx.scale(1, MM.tilt);
  ctx.strokeStyle = "rgba(51,221,255,0.7)"; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(0, 0, MM.r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // north marker on the rim
  const nPos = toMap(0, radiusM * 10);
  const nl = Math.hypot(nPos.x, nPos.y) || 1;
  text("N", MM.x + (nPos.x / nl) * (MM.r + 12), MM.y + (nPos.y / nl) * (MM.r + 12) * MM.tilt, { size: 15, color: RED, weight: 800 });
  // pins: glowing dots (round, drawn after the tilt so they stay round)
  for (const it of items) {
    let { x, y } = toMap(it.rel.e, it.rel.n);
    const d = Math.hypot(x, y);
    const edge = d > MM.r - 6;
    if (edge) { x *= (MM.r - 6) / d; y *= (MM.r - 6) / d; }
    const px = MM.x + x, py = MM.y + y * MM.tilt;
    glow(px, py, it.isT ? 5 : 3.5, it.isT ? RGB.cyan : RGB.green, edge ? 0.6 : 1);
    if (it.isT) text(it.pin.name, px, py - 16, { size: 14, color: WHITE, weight: 700 });
  }
  // you
  ctx.fillStyle = WHITE;
  ctx.beginPath(); ctx.moveTo(MM.x, MM.y - 11); ctx.lineTo(MM.x + 8, MM.y + 7); ctx.lineTo(MM.x, MM.y + 3); ctx.lineTo(MM.x - 8, MM.y + 7); ctx.closePath(); ctx.fill();
  text(`${G.fmtDist(radiusM, S.settings.units)} ring`, MM.x - MM.r + 2, MM.y + MM.r * MM.tilt + 12, { size: 13, color: DIM, align: "left", weight: 600 });
}

function drawGuide({ pin, rel }, heading, pitch, arrived) {
  const u = S.settings.units, x = 232;
  const lvl = levelText(pin, rel);
  let line2;
  if (arrived) line2 = "You're here";
  else if (rel.flat < 3 && !lvl) line2 = "Right next to you";
  else {
    const turn = rel.flat < 0.5 ? 0 : G.wrap180(G.bearingOf(rel.e, rel.n) - heading);
    if (Math.abs(turn) > 135) line2 = "Turn around";
    else if (Math.abs(turn) > 12) line2 = `Turn ${turn > 0 ? "right" : "left"} ${Math.round(Math.abs(turn))}°`;
    else line2 = lvl ? (lvl.startsWith("↓") ? "Ahead, below you" : "Ahead, above you") : "Straight ahead";
  }
  text(pin.name, x, 470, { size: 22, color: pin.id === S.target ? CYAN : GREEN, align: "left", weight: 700 });
  text(`${G.fmtDist(rel.flat, u)}${lvl ? " · " + lvl : ""}`, x, 498, { size: 20, color: WHITE, align: "left", weight: 600 });
  text(line2, x, 526, { size: 20, color: WHITE, align: "left", weight: 600 });
}

function drawStatus() {
  const s = S.settings;
  const floor = s.heightMode === "altitude" && RT.alt != null ? `Alt ${G.fmtDist(RT.alt, s.units)}` : `Floor ${S.floor}`;
  const f = RT.filter;
  const where = !S.work ? (RT.geoErr ? "no location" : "finding you…") : S.work.prov ? "steps only" : `±${G.fmtDist(f.acc, s.units)}`;
  const north = s.autoAlign && RT.aligner.ready ? "N ✓" : "N ~";
  text(`${floor} · ${where} · ${north}`, W - 16, 580, { size: 16, color: f.acc > 25 ? RED : DIM, align: "right", weight: 600 });
}

// ---------- map (OpenStreetMap, dimmed so it doesn't block your view) ----------

const tiles = new Map();
function tile(z, x, y) {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const key = `${z}/${x}/${y}`;
  let t = tiles.get(key);
  if (t && t.failedAt && performance.now() - t.failedAt > 30000) { tiles.delete(key); t = null; } // retry after 30 s
  if (!t) {
    t = { ready: null, dim: false, failedAt: 0 };
    const img = new Image();
    img.onerror = () => { t.failedAt = performance.now(); }; // no internet: don't hammer the server every frame
    img.onload = () => {
      // Darken once here (black = see-through on the glasses), not on every frame.
      const cv = document.createElement("canvas");
      cv.width = cv.height = 256;
      const c2 = cv.getContext("2d");
      if ("filter" in c2) { c2.filter = TILE_FILTER; c2.drawImage(img, 0, 0); t.ready = cv; }
      else { t.ready = img; t.dim = true; }
    };
    img.src = `https://tile.openstreetmap.org/${key}.png`;
    tiles.set(key, t);
    if (tiles.size > 40) {
      const oldKey = tiles.keys().next().value;
      const old = tiles.get(oldKey);
      if (old && old.ready && old.ready.width) old.ready.width = 0; // free the memory now
      tiles.delete(oldKey);
    }
  }
  else { tiles.delete(key); tiles.set(key, t); } // most recently used goes last
  return t.ready ? t : null;
}
const TILE_FILTER = "invert(1) hue-rotate(180deg) brightness(0.75) contrast(1.2)";
function worldPx(lat, lon, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin(G.clamp(lat, -85, 85) * G.D2R);
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

function drawMap() {
  const me = here();
  if (!me || S.work.prov) {
    text("The map needs a GPS fix", CX, CY - 16, { size: 24 });
    text("Pinch for the menu", CX, CY + 22, { size: 20, color: DIM });
    return;
  }
  const z = S.mapZoom;
  const heading = RT.pose ? RT.pose.heading : 0;
  const c = worldPx(me.lat, me.lon, z);
  ctx.save();
  try {
    ctx.beginPath(); ctx.arc(CX, CY, 270, 0, Math.PI * 2); ctx.clip();
    ctx.translate(CX, CY);
    ctx.rotate(-heading * G.D2R);
    const R = 400;
    for (let ty = Math.floor((c.y - R) / 256); ty <= Math.floor((c.y + R) / 256); ty++) {
      for (let tx = Math.floor((c.x - R) / 256); tx <= Math.floor((c.x + R) / 256); tx++) {
        const t = tile(z, tx, ty);
        if (!t) continue;
        ctx.globalAlpha = t.dim ? 0.35 : 1;
        ctx.drawImage(t.ready, tx * 256 - c.x, ty * 256 - c.y, 256, 256);
      }
    }
  } finally {
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // accuracy circle
  const mPerPx = (156543.03392 * Math.cos(me.lat * G.D2R)) / 2 ** z;
  ctx.strokeStyle = "rgba(51,221,255,0.5)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(CX, CY, G.clamp(RT.filter.acc / mPerPx, 6, 260), 0, Math.PI * 2); ctx.stroke();
  // you (drawn first so pin labels stay readable on top)
  ctx.fillStyle = WHITE;
  ctx.beginPath(); ctx.moveTo(CX, CY - 14); ctx.lineTo(CX + 10, CY + 10); ctx.lineTo(CX, CY + 4); ctx.lineTo(CX - 10, CY + 10); ctx.closePath(); ctx.fill();
  // pins (positions rotated so the way you face is up; labels stay upright)
  const cosH = Math.cos(-heading * G.D2R), sinH = Math.sin(-heading * G.D2R);
  for (const pin of S.pins) {
    const w = worldPx(pin.lat, pin.lon, z);
    const dx = w.x - c.x, dy = w.y - c.y;
    let x = dx * cosH - dy * sinH, y = dx * sinH + dy * cosH;
    const d = Math.hypot(x, y);
    if (d > 255) { x *= 255 / d; y *= 255 / d; }
    const isT = pin.id === S.target;
    ctx.fillStyle = isT ? CYAN : GREEN;
    ctx.beginPath(); ctx.arc(CX + x, CY + y, isT ? 9 : 7, 0, Math.PI * 2); ctx.fill();
    text(pin.name, CX + x, CY + y - 20, { size: 18, color: WHITE, weight: 700 });
  }
  text(`${G.cardinal(heading)} ${Math.round(heading)}°`, CX, 20, { size: 18, color: CYAN, weight: 700 });
  text("© OpenStreetMap", W - 12, 588, { size: 14, color: DIM, align: "right", weight: 500 });
  text("Swipe up/down: zoom · pinch: menu", 12, 588, { size: 14, color: DIM, align: "left", weight: 500 });
}

// ---------- go ----------

load();
setInterval(() => { if (RT.screen === "list" && RT.list?.def?.live) refreshValues(); }, 250);
requestAnimationFrame(frame);

// For testing in a browser: window.__waypoint exposes state (harmless on the glasses).
window.__waypoint = { S, RT, G, handleKey, goBack, resyncAt, save, onFix };
