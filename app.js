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
  gps: "auto",          // auto (ignore poor indoor fixes) | always | off
  fov: 14,              // degrees across the display (for lining pins up with the world)
  offset: 0,            // extra heading trim, degrees
  north: "magnetic",    // what the glasses' compass reports: magnetic (we add the local declination) | true
};
const CHOICES = { units: ["ft", "m"], heightMode: ["floors", "altitude"], gps: ["auto", "always", "off"], north: ["magnetic", "true"] };
const LIMITS = { floorH: [2.4, 6], stepLen: [0.4, 1.1], stepSens: [0.3, 4], fov: [5, 60], offset: [-180, 180] };
const CYAN = "#33ddff", GREEN = "#7fff9f", WHITE = "#ffffff", DIM = "#8a8a8a", RED = "#ff6a5a";

// ---------- saved state ----------
const S = { pins: [], settings: { ...DEFAULTS }, cal: null, floor: 1, work: null, pos: { e: 0, n: 0 }, target: null, mapZoom: 18, decl: null };
// ---------- live state ----------
const RT = {
  screen: "start", list: null, stack: [],
  Rs: null, raw: null, absolute: false, lastAbsT: -1e9, samples: [],
  orientCount: 0, orientRate: 0, motionCount: 0, motionRate: 0,
  pose: null, walkHeading: null,
  steps: new G.StepDetector(), filter: new G.PosFilter(), accel: NaN,
  fix: null, fixes: 0, lastStepT: -1e9, lastCand: -1e9, streak: 0, walkSteps: 0, yawRate: 0, prevH: null, prevHT: 0,
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
      S.pins = Array.isArray(j.pins) ? j.pins.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) : [];
      S.settings = cleanSettings(j.settings);
      S.cal = validCal(j.cal) ? j.cal : null;
      S.floor = Number.isFinite(j.floor) ? j.floor : 1;
      S.work = j.work && Number.isFinite(j.work.lat) ? j.work : null;
      S.pos = j.pos && Number.isFinite(j.pos.e) ? j.pos : { e: 0, n: 0 };
      S.target = j.target ?? null;
      S.mapZoom = Number.isFinite(j.mapZoom) ? G.clamp(j.mapZoom, 12, 19) : 18;
      if (j.decl && [j.decl.v, j.decl.lat, j.decl.lon].every(Number.isFinite)) {
        // Last known declination: correct magnetic north right away, before any GPS fix.
        S.decl = j.decl; RT.decl = j.decl.v; RT.declAt = { lat: j.decl.lat, lon: j.decl.lon, stale: true };
      }
    }
  } catch { /* storage unavailable: start fresh */ }
  const f = RT.filter;
  f.e = S.pos.e; f.n = S.pos.n;
  if (S.work && !S.work.prov) { f.has = true; f.P = 60 * 60; } // last known spot; the next fix corrects it
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
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
function validCal(c) { return !!c && vec3(c.fwd) && vec3(c.right) && vec3(c.up) && typeof c.mirror === "boolean"; }

function save() {
  S.pos = { e: RT.filter.e, n: RT.filter.n };
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
  if (abs && !RT.sawAbs) { RT.sawAbs = true; RT.Rs = null; RT.samples = []; }
  RT.absolute = abs;
  RT.lastOrientT = now;
  RT.raw = { a, b, g };
  RT.orientCount++;
  RT.samples.push({ a, b, g, t: now });
  while (RT.samples.length && now - RT.samples[0].t > 1000) RT.samples.shift();
  if (S.cal) RT.Rs = G.blendRot(RT.Rs, G.rotForReading(a, b, g, S.cal), 0.25);
}
window.addEventListener("deviceorientationabsolute", (e) => onOrient(e, true));
window.addEventListener("deviceorientation", (e) => onOrient(e, false));

window.addEventListener("devicemotion", (ev) => {
  const a = ev.accelerationIncludingGravity || ev.acceleration;
  if (!a || a.x == null) return;
  const mag = Math.hypot(a.x, a.y || 0, a.z || 0);
  RT.accel = mag; RT.motionCount++;
  const now = performance.now();
  if (!RT.steps.push(mag, now, S.settings.stepSens)) return;
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
             alt: c.altitude, altAcc: c.altitudeAccuracy, t: Date.now() };
  if (Number.isFinite(c.altitude)) RT.alt = RT.alt == null ? c.altitude : RT.alt + (c.altitude - RT.alt) * 0.3;
  const f = RT.filter, mode = S.settings.gps, acc = RT.fix.acc;
  if (mode === "off" && f.has) return;
  // Indoors GPS is often 30-60 m off; steps are better there. Take a poor fix only if we know even less.
  if (mode === "auto" && f.has && acc > 25 && acc >= f.sigma) return;
  anchor(RT.fix);
  const z = G.enu(S.work.lat, S.work.lon, RT.fix.lat, RT.fix.lon);
  predict();
  f.fix(z.e, z.n, acc);
  afterMove();
}

/** Grow position doubt with time. Walking with steps counted: steps carry the movement.
 *  No steps lately: probably standing still, a little doubt. Step tracking off: you could be walking. */
let lastPredict = performance.now();
function predict() {
  const now = performance.now();
  const q = !S.settings.steps ? 3 : now - RT.lastStepT < 3000 ? 0.05 : 0.5;
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
  RT.motionRate = RT.motionCount; RT.motionCount = 0;
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

function dropPin(name) {
  if (!S.work) S.work = { lat: 0, lon: 0, prov: true }; // no fix yet: steps only, tied to the map later
  const me = here();
  const pin = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, lat: me.lat, lon: me.lon,
                floor: S.floor, alt: RT.alt, acc: RT.filter.sigma, t: Date.now() };
  if (S.work.prov) pin.prov = true;
  S.pins.push(pin);
  save();
  toast(`Dropped ${name} · floor ${S.floor}${pin.prov ? " · no GPS yet, using steps" : RT.filter.sigma > 25 ? " · rough spot" : ""}`);
}

function movePinHere(pin) {
  if (!S.work) S.work = { lat: 0, lon: 0, prov: true };
  const me = here();
  pin.lat = me.lat; pin.lon = me.lon; pin.floor = S.floor; pin.alt = RT.alt; pin.acc = RT.filter.sigma; pin.t = Date.now();
  if (S.work.prov) pin.prov = true; else delete pin.prov;
  save();
  toast(`Moved ${pin.name} here`);
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

function mainMenu() {
  return {
    title: "Waypoint",
    items: [
      { label: "Drop pin here", enter: () => openList(dropMenu) },
      { label: "Pins", value: () => String(S.pins.length), enter: () => openList(pinsMenu) },
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

function dropMenu() {
  const drop = (name) => { dropPin(name); closeAll(); };
  return {
    title: `Drop pin · floor ${S.floor}`,
    items: [
      { input: true, label: "Say or write a name…", submit: (v) => drop(uniqueName(v.slice(0, 30))) },
      ...NAMES.map((n) => ({ label: n, enter: () => drop(uniqueName(n)) })),
    ],
    hint: RT.filter.sigma > 25 ? "Location is rough right now (weak GPS)" : "Pick a name, or pinch the top box to say one",
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
      { label: "Move pin to where I am", enter: () => { movePinHere(pin); goBack(); } },
      { label: confirming ? "Pinch again to delete" : "Delete", danger: true,
        enter: () => { if (confirming) { deletePin(pin); goBack(); } else { RT.confirm = `del:${pin.id}`; refreshValues(); } } },
    ],
    hint: `Floor ${pin.floor} · ${when}${pin.prov ? " · steps only" : pin.acc > 25 ? " · rough spot" : ""}`,
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
      { label: "GPS", value: () => ({ auto: "auto", always: "always", off: "off (indoors)" })[s.gps], left: () => set("gps", cycle(["auto", "always", "off"], s.gps, -1)), right: () => set("gps", cycle(["auto", "always", "off"], s.gps, 1)) },
      { label: "View width", value: () => `${s.fov}°`, left: () => set("fov", G.clamp(s.fov - 1, 5, 60)), right: () => set("fov", G.clamp(s.fov + 1, 5, 60)) },
      { label: "Compass north", value: () => (s.north === "magnetic" ? `magnetic (fix ${fmtDecl()})` : "true"), left: flip("north", "magnetic", "true"), right: flip("north", "magnetic", "true") },
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
      { label: "North fix", value: () => (s.north === "magnetic" ? `${fmtDecl()} (magnetic→true)` : "off (compass is true)") },
      { label: "Pitch · roll", value: () => (RT.pose ? `${Math.round(RT.pose.pitch) || 0}° · ${Math.round(RT.pose.roll) || 0}°` : "–") },
      { label: "Compass", value: () => (RT.raw ? `${RT.absolute ? "absolute" : "relative!"} · ${RT.orientRate}/s` : "no data") },
      { label: "Raw α β γ", value: () => (RT.raw ? `${fmt(RT.raw.a)} ${fmt(RT.raw.b)} ${fmt(RT.raw.g)}` : "–") },
      { label: "Motion", value: () => `${fmt(RT.accel, 1)} m/s² · ${RT.walkSteps} steps (${RT.steps.count} bounces)` },
      { label: "GPS", value: () => (fix ? `±${fmt(fix.acc)} m · ${age}s ago · ${RT.fixes}` : RT.geoErr || "waiting") },
      { label: "Altitude", value: () => (fix && Number.isFinite(fix.alt) ? `${fmt(fix.alt, 1)} m ±${fmt(fix.altAcc)} (avg ${fmt(RT.alt, 1)})` : "none") },
      { label: "My position", value: () => (S.work ? `±${fmt(f.sigma)} m${S.work.prov ? " (steps only)" : ""}` : "unknown") },
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
  const cal = G.solveCalibration(level, right, down);
  if (!cal.ok) {
    RT.calCaps = []; RT.calStep = 0;
    RT.calMsg = cal.why === "down" ? "Didn't see you look down — let's go again" : "Didn't see you turn right — let's go again";
    return;
  }
  S.cal = { fwd: cal.fwd, right: cal.right, up: cal.up, mirror: cal.mirror, offset: 0 };
  RT.Rs = null;
  save();
  go(RT.home);
  syncHistory();
  toast("Calibrated");
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
      if (k === "ok") openList(mainMenu);
      else if (k === "left") cycleTarget(-1);
      else if (k === "right") cycleTarget(1);
      break;
    case "map":
      if (k === "up") { S.mapZoom = Math.min(19, S.mapZoom + 1); save(); }
      else if (k === "down") { S.mapZoom = Math.max(12, S.mapZoom - 1); save(); }
      else if (k === "left") cycleTarget(-1);
      else if (k === "right") cycleTarget(1);
      else if (k === "back") goBack();
      else if (k === "ok") openList(mainMenu);
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
function fmtDecl() { return RT.declAt ? `${RT.decl >= 0 ? "+" : ""}${RT.decl.toFixed(1)}°` : "needs GPS"; }

let lastDraw = 0;
function frame(now) {
  requestAnimationFrame(frame); // keep going even if something below throws
  if (now - lastDraw < 32) return; // ~30 fps is plenty and saves battery
  lastDraw = now;
  if (!toastEl.hidden && performance.now() > RT.toastUntil) toastEl.hidden = true;
  if (RT.screen === "list") return; // the menu covers the view
  try {
    updateDecl();
    if (S.cal) S.cal.offset = S.settings.offset + (S.settings.north === "magnetic" ? RT.decl : 0);
    if (RT.Rs && S.cal) {
      RT.pose = G.headPose(RT.Rs, S.cal);
      const now = performance.now();
      if (RT.prevH != null && now > RT.prevHT) {
        const rate = Math.abs(G.wrap180(RT.pose.heading - RT.prevH)) / ((now - RT.prevHT) / 1000);
        RT.yawRate += (Math.min(rate, 720) - RT.yawRate) * 0.3;
      }
      RT.prevH = RT.pose.heading; RT.prevHT = now;
      if (Math.abs(RT.pose.pitch) < 60) RT.walkHeading = RT.pose.heading; // steady walking direction
    }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (RT.screen === "start") drawStart();
    else if (RT.screen === "ar") drawAR();
    else if (RT.screen === "map") drawMap();
    else if (RT.screen === "calib") drawCalib();
    if (!toastEl.hidden && performance.now() > RT.toastUntil) toastEl.hidden = true;
    RT.frameErr = null;
  } catch (e) {
    RT.frameErr = String(e && e.message || e);
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
  text(S.cal ? "Swipe down to cancel" : "", CX, 540, { size: 18, color: DIM, weight: 500 });
}

function focal() { return (W / 2) / Math.tan((S.settings.fov / 2) * G.D2R); }

function drawAR() {
  if (!S.cal) { text("Needs calibrating — pinch for the menu", CX, CY, { size: 22 }); return; }
  if (!RT.Rs || !RT.pose) { text("Waiting for the compass…", CX, CY, { size: 24 }); drawStatus(); return; }
  const heading = RT.pose.heading;
  drawTape(heading);
  const F = focal();
  const target = targetPin();
  const items = [];
  for (const pin of S.pins) {
    const rel = relOf(pin);
    if (!rel) continue;
    const p = G.project(RT.Rs, S.cal, rel, F, CX, CY);
    items.push({ pin, rel, p });
  }
  items.sort((a, b) => b.p.dist - a.p.dist); // far first, near on top
  for (const it of items) {
    const isT = target && it.pin.id === target.id;
    const on = it.p.z > 0.02 && it.p.x > -20 && it.p.x < W + 20 && it.p.y > 50 && it.p.y < H - 40;
    if (on) drawPin(it, isT);
    else drawEdge(it, isT);
  }
  if (target) {
    const it = items.find((i) => i.pin.id === target.id);
    if (it) drawGuide(it, heading);
  }
  if (performance.now() - RT.lastOrientT > 3000) text("Compass stopped — close and reopen the app", CX, 470, { size: 17, color: RED, weight: 600 });
  else if (!RT.absolute) text("Compass isn't locked to north — pins may drift", CX, 470, { size: 17, color: RED, weight: 600 });
  drawStatus();
}

function drawTape(heading) {
  const span = 45, y = 34, pxPerDeg = 540 / (span * 2);
  ctx.strokeStyle = DIM; ctx.lineWidth = 2;
  for (let d = Math.ceil((heading - span) / 5) * 5; d <= heading + span; d += 5) {
    const x = CX + (d - heading) * pxPerDeg;
    const big = G.wrap360(d) % 45 === 0;
    ctx.beginPath(); ctx.moveTo(x, y + 14); ctx.lineTo(x, y + (big ? 2 : 8)); ctx.stroke();
    if (big) text(G.cardinal(d), x, y - 10, { size: 18, color: G.wrap360(d) === 0 ? RED : WHITE, weight: 700 });
  }
  for (const pin of S.pins) {
    const rel = relOf(pin);
    if (!rel || rel.flat < 1) continue;
    const rd = G.wrap180(G.bearingOf(rel.e, rel.n) - heading);
    const x = CX + G.clamp(rd, -span, span) * pxPerDeg;
    const isT = pin.id === S.target;
    ctx.fillStyle = isT ? CYAN : GREEN;
    ctx.beginPath(); ctx.moveTo(x, y + 18); ctx.lineTo(x - 7, y + 30); ctx.lineTo(x + 7, y + 30); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = WHITE;
  ctx.beginPath(); ctx.moveTo(CX, y + 16); ctx.lineTo(CX - 6, y + 4); ctx.lineTo(CX + 6, y + 4); ctx.closePath(); ctx.fill();
  text(`${Math.round(heading)}°`, CX, y + 46, { size: 16, color: CYAN, weight: 700 });
}

function drawPin({ pin, rel, p }, isT) {
  const color = isT ? CYAN : GREEN;
  const r = G.clamp(150 / Math.sqrt(Math.max(p.dist, 4)), 7, 26);
  const stem = G.clamp(r * 2.2, 18, 60);
  // ground spot
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(p.x, p.y, r * 0.9, r * 0.35, 0, 0, Math.PI * 2); ctx.stroke();
  // stem and head floating above it
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - stem); ctx.stroke();
  ctx.fillStyle = color;
  const hy = p.y - stem - r;
  ctx.beginPath(); ctx.moveTo(p.x, hy - r); ctx.lineTo(p.x + r, hy); ctx.lineTo(p.x, hy + r); ctx.lineTo(p.x - r, hy); ctx.closePath(); ctx.fill();
  const lvl = levelText(pin, rel);
  text(pin.name, p.x, hy - r - 26, { size: isT ? 24 : 20, color: WHITE, weight: 700 });
  text(`${G.fmtDist(rel.flat, S.settings.units)}${lvl ? " · " + lvl : ""}`, p.x, hy - r - 6, { size: 18, color, weight: 600 });
}

function drawEdge({ pin, rel, p }, isT) {
  const th = p.angle;
  const bottom = S.target ? 455 : 520; // stay clear of the guidance text
  const cx = CX, cy = (70 + bottom) / 2, hw = W / 2 - 34, hh = (bottom - 70) / 2;
  const t = Math.min(hw / Math.abs(Math.cos(th) || 1e-9), hh / Math.abs(Math.sin(th) || 1e-9));
  const x = cx + t * Math.cos(th), y = cy + t * Math.sin(th);
  const s = isT ? 16 : 9;
  ctx.save(); ctx.translate(x, y); ctx.rotate(th);
  ctx.fillStyle = isT ? CYAN : GREEN;
  ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s, -s * 0.8); ctx.lineTo(-s * 0.4, 0); ctx.lineTo(-s, s * 0.8); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawGuide({ pin, rel, p }, heading) {
  const u = S.settings.units;
  const lvl = levelText(pin, rel);
  const sameLevel = !lvl;
  let line2;
  if (rel.flat < Math.max(4, Math.min(RT.filter.sigma, 15)) && sameLevel) line2 = "You're here";
  else {
    const turn = G.wrap180(G.bearingOf(rel.e, rel.n) - heading);
    const onScreen = p.z > 0.02 && p.x > 0 && p.x < W && p.y > 50 && p.y < H - 40;
    if (rel.flat >= 3 && Math.abs(turn) > 20) line2 = `Turn ${turn > 0 ? "right" : "left"} ${Math.round(Math.abs(turn))}°`;
    else if (onScreen) line2 = "Right there";
    else {
      const elev = Math.atan2(rel.up, rel.flat) * G.R2D;
      line2 = elev < RT.pose.pitch ? "Look down" : "Look up";
    }
  }
  text(`${pin.name} · ${G.fmtDist(rel.flat, u)}${lvl ? " · " + lvl : ""}`, CX, 522, { size: 22, color: CYAN, weight: 700 });
  text(line2, CX, 496, { size: 20, color: WHITE, weight: 600 });
}

function drawStatus() {
  const s = S.settings;
  const left = s.heightMode === "altitude" && RT.alt != null ? `Alt ${G.fmtDist(RT.alt, s.units)}` : `Floor ${S.floor}`;
  const f = RT.filter;
  const mid = !S.work ? (RT.geoErr ? "No location" : "Finding you…") : S.work.prov ? "Steps only" : `±${G.fmtDist(f.sigma, s.units)}`;
  text(left, 24, 572, { size: 18, color: DIM, align: "left", weight: 600 });
  text(mid, CX, 572, { size: 18, color: f.sigma > 25 ? RED : DIM, weight: 600 });
  text(`${S.pins.length} pin${S.pins.length === 1 ? "" : "s"}`, W - 24, 572, { size: 18, color: DIM, align: "right", weight: 600 });
}

// ---------- map (OpenStreetMap, dimmed so it doesn't block your view) ----------

const tiles = new Map();
function tile(z, x, y) {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const key = `${z}/${x}/${y}`;
  let t = tiles.get(key);
  if (!t) {
    t = { ready: null, dim: false };
    const img = new Image();
    img.onerror = () => tiles.delete(key); // try again next time it's needed
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
  ctx.beginPath(); ctx.arc(CX, CY, G.clamp(RT.filter.sigma / mPerPx, 6, 260), 0, Math.PI * 2); ctx.stroke();
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
  // you
  ctx.fillStyle = WHITE;
  ctx.beginPath(); ctx.moveTo(CX, CY - 14); ctx.lineTo(CX + 10, CY + 10); ctx.lineTo(CX, CY + 4); ctx.lineTo(CX - 10, CY + 10); ctx.closePath(); ctx.fill();
  text(`${G.cardinal(heading)} ${Math.round(heading)}°`, CX, 20, { size: 18, color: CYAN, weight: 700 });
  text("© OpenStreetMap", W - 12, 588, { size: 14, color: DIM, align: "right", weight: 500 });
  text("Swipe up/down: zoom · pinch: menu", 12, 588, { size: 14, color: DIM, align: "left", weight: 500 });
}

// ---------- go ----------

load();
setInterval(() => { if (RT.screen === "list" && RT.list?.def?.live) refreshValues(); }, 250);
requestAnimationFrame(frame);

// For testing in a browser: window.__waypoint exposes state (harmless on the glasses).
window.__waypoint = { S, RT, G, handleKey, goBack };
