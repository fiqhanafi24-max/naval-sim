// Browser front end: CesiumJS globe + DOM panels around the headless World.
/* global Cesium */

import { World, isAntiShip, ammoLeft } from "../sim/world.js";
import { predict } from "../sim/missile.js";
import { DEG, bearing, groundRange_m } from "../sim/geo.js";
import { buildShipGltf } from "./models.js";
import { Effects } from "./effects.js";
import { COLORS, PLAYER, SYMBOLS, createViewer, listScenarios, loadScenario } from "./common.js";

const SIM_DT = 0.1;
const MAX_STEPS_PER_FRAME = 1200;

const params = new URLSearchParams(location.search);
const scenarioName = params.get("scenario") || "norwegian-sea";

const [data, atmo, scenario] = await Promise.all([
  fetch("data/gcb-units.json").then((r) => r.json()),
  fetch("data/atmosphere.csv").then((r) => r.text()),
  loadScenario(scenarioName),
]);

const world = new World(data, atmo, scenario);

// ------------------------------------------------------------------ globe

const viewer = createViewer("globe", scenario.camera);

const pos = (o, extra = 0) => Cesium.Cartesian3.fromRadians(o.lon, o.lat, Math.max(o.alt || 0, 0) + extra);

const entities = new Map(); // key -> entity
function upsert(key, make) {
  let e = entities.get(key);
  if (!e) {
    e = viewer.entities.add(make());
    e._key = key;
    entities.set(key, e);
  }
  e._seen = true;
  return e;
}

/**
 * Set a polyline's points. Lines that change every frame must use a CallbackProperty:
 * a new constant array each frame restarts Cesium's background geometry build, so the
 * line never appears.
 */
function setLine(e, pts) {
  if (!e._line) {
    e._line = true;
    e.polyline.positions = new Cesium.CallbackProperty(() => e._pts || [], false);
  }
  e._pts = pts;
}

let selectedId = world.ships(PLAYER)[0]?.id ?? null;
let targetId = null; // hostile track selected as the target for engage orders
let showTruth = false;
let showRings = true;
let plotting = false; // plot-course mode: map clicks add waypoints

// one generated glTF per ship class
const modelUris = new Map();
function shipModel(className) {
  if (!modelUris.has(className)) {
    const db = data.ships[className];
    modelUris.set(className, db ? buildShipGltf(db, db.country === "USA" ? "us" : "soviet") : null);
  }
  return modelUris.get(className);
}

const SINK_S = 150; // sim seconds for a sunk ship to settle and disappear
const deathTime = new Map(); // ship id -> sim time first seen dead
const trackedEnemies = new Set(); // enemy ships the player has held on radar

function shipEntity(key, o, side, isTrack) {
  const className = o.className || o.db?.name;
  const uri = shipModel(className);
  const e = upsert(key, () => ({
    billboard: { image: SYMBOLS[`${side}-ship`], verticalOrigin: Cesium.VerticalOrigin.CENTER, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: {
      text: "", font: "12px sans-serif", fillColor: COLORS[side], outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -24),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    model: uri ? { uri, minimumPixelSize: 0, shadows: Cesium.ShadowMode.DISABLED } : undefined,
  }));
  const dead = o.dead;
  // sinking: settle, list and go down over SINK_S, then only the grey symbol remains
  let sink = 0;
  if (dead) {
    if (!deathTime.has(o.id)) deathTime.set(o.id, world.t);
    sink = Math.min(1, (world.t - deathTime.get(o.id)) / SINK_S);
  }
  const depth = sink * 3 * (data.ships[className]?.effectiveHeight_m || 10);
  const p = Cesium.Cartesian3.fromRadians(o.lon, o.lat, -depth);
  e.position = p;
  const hpr = new Cesium.HeadingPitchRoll(o.heading - Math.PI / 2, -0.08 * sink, 0.35 * sink);
  e.orientation = Cesium.Transforms.headingPitchRollQuaternion(p, hpr);
  // contacts show a 3D model only once identified on radar; reports give an uncertain position
  if (e.model) e.model.show = (!isTrack || (o.error_m === 0 && o.identified)) && sink < 1;
  e.label.text = isTrack ? `${world.trackName(o)}${o.error_m ? " (reported)" : ""}` : `${o.name}${dead ? " (sunk)" : ""}`;
  e.billboard.color = dead ? Cesium.Color.GRAY : Cesium.Color.WHITE;
  e._objId = o.id;
  return e;
}

// ship wakes: recent positions sampled in sim time
const WAKE_SAMPLE_S = 10;
const WAKE_POINTS = 12;
const wakes = new Map(); // id -> {last, pts}
function wakeEntity(o) {
  let w = wakes.get(o.id);
  if (!w) wakes.set(o.id, (w = { last: -1e9, pts: [] }));
  if (world.t - w.last >= WAKE_SAMPLE_S) {
    w.last = world.t;
    w.pts.push(Cesium.Cartesian3.fromRadians(o.lon, o.lat, 1));
    if (w.pts.length > WAKE_POINTS) w.pts.shift();
  }
  if (o.dead || o.speed_kts < 1 || w.pts.length < 2) return;
  const e = upsert(`w${o.id}`, () => ({
    polyline: { positions: [], width: 6, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.3, color: Cesium.Color.WHITE.withAlpha(0.35) }) },
  }));
  setLine(e, [...w.pts, Cesium.Cartesian3.fromRadians(o.lon, o.lat, 1)]);
}

const effects = new Effects(viewer);
const seenDetonations = new Set();

function missileEntity(key, o, side) {
  const e = upsert(key, () => ({
    billboard: { image: SYMBOLS[`${side}-missile`], disableDepthTestDistance: Number.POSITIVE_INFINITY },
    // smoke trail
    polyline: { positions: [], width: 5, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.25, color: Cesium.Color.WHITE.withAlpha(0.5) }) },
  }));
  e.position = pos(o);
  if (o.trail) setLine(e, [...o.trail.map((p) => pos(p)), pos(o)]);
  e._objId = o.id;
  return e;
}

/** Aircraft (own, or hostile tracks): air symbol with name and flight level. */
function airEntity(key, o, side, isTrack) {
  const e = upsert(key, () => ({
    billboard: { image: SYMBOLS[`${side}-aircraft`], disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: {
      text: "", font: "11px sans-serif", fillColor: COLORS[side], outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -18),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }));
  e.position = pos(o);
  e.label.text = `${isTrack ? world.trackName(o) : o.name}  FL${String(Math.round(o.alt / 30.48)).padStart(3, "0")}`;
  e._objId = o.id;
  return e;
}

/** Gun rounds and close-in-weapon bursts: small tracer dots, no label. */
function roundEntity(key, o) {
  const e = upsert(key, () => ({
    point: { pixelSize: 3, color: COLORS.amber, disableDepthTestDistance: Number.POSITIVE_INFINITY },
  }));
  e.position = pos(o);
  return e;
}

function ring(key, center, radius_m, color, dashed) {
  const e = upsert(key, () => ({
    polyline: {
      positions: [], width: dashed ? 1.5 : 2, clampToGround: false,
      material: dashed ? new Cesium.PolylineDashMaterialProperty({ color }) : color,
    },
  }));
  const pts = [];
  for (let a = 0; a <= 360; a += 5) {
    const p = { lat: center.lat, lon: center.lon };
    const d = radius_m / 6378140;
    const lat = Math.asin(Math.sin(p.lat) * Math.cos(d) + Math.cos(p.lat) * Math.sin(d) * Math.cos(a * DEG));
    const lon = p.lon + Math.atan2(Math.sin(a * DEG) * Math.sin(d) * Math.cos(p.lat), Math.cos(d) - Math.sin(p.lat) * Math.sin(lat));
    pts.push(Cesium.Cartesian3.fromRadians(lon, lat, 200));
  }
  setLine(e, pts);
  // rings hug the sea surface; draw them even where the globe would hide them
  if (!e.polyline.depthFailMaterial) e.polyline.depthFailMaterial = e.polyline.material;
}

/**
 * Range rings for a unit: sensors in green (vs ships) and yellow-green (vs aircraft),
 * weapons in red (solid: anti-air, dashed: anti-surface).
 */
const RING_SENSOR_SURFACE = Cesium.Color.fromCssColorString("#4cd18a").withAlpha(0.7);
const RING_SENSOR_AIR = Cesium.Color.fromCssColorString("#d6e05a").withAlpha(0.6);
const RING_WEAPON = Cesium.Color.fromCssColorString("#ff5a52").withAlpha(0.7);
function rangeRings(o) {
  const active = o.radars.filter((r) => r.active && r.db.isSurveillance !== false);
  const vsShip = Math.max(0, ...active.filter((r) => r.db.detectsSurface).map((r) => r.nominalRange_km(40, 10)));
  const vsAir = Math.max(0, ...active.filter((r) => r.db.detectsAir).map((r) => r.nominalRange_km(5, 5000)));
  if (vsShip) ring("rs", o, 1000 * vsShip, RING_SENSOR_SURFACE, false);
  if (vsAir) ring("ra", o, 1000 * vsAir, RING_SENSOR_AIR, false);
  const ranges = new Map(); // range_km -> dashed (anti-surface only)
  for (const L of o.launchers) {
    if (ammoLeft(o, L) <= 0) continue;
    const db = L.kind === "gun" ? data.guns[L.item] : data.missiles[L.item];
    if (!db) continue;
    const r = Math.round(db.maxRange_km);
    const antiAir = L.kind === "gun" ? (db.targetFlags & 10) !== 0 : !isAntiShip(db);
    ranges.set(r, (ranges.get(r) ?? true) && !antiAir);
  }
  for (const [r, dashed] of ranges) ring(`rw${r}`, o, 1000 * r, RING_WEAPON, dashed);
}

/** ESM bearing lines (strobes) for a bearing-only contact; the latest one is labelled. */
const STROBE_KM = 200;
const STROBE_COLOR = Cesium.Color.fromCssColorString("#ffb547").withAlpha(0.75);
function strobes(tr) {
  const recent = tr.bearings.slice(-3);
  recent.forEach((b, i) => {
    const end = offsetLL(b, b.brg, STROBE_KM * 1000);
    const e = upsert(`strobe${tr.id}-${i}`, () => ({
      polyline: { positions: [], width: i === recent.length - 1 ? 2 : 1, material: new Cesium.PolylineDashMaterialProperty({ color: STROBE_COLOR, dashLength: 10 }) },
    }));
    setLine(e, [Cesium.Cartesian3.fromRadians(b.lon, b.lat, 100), Cesium.Cartesian3.fromRadians(end.lon, end.lat, 100)]);
    if (i === recent.length - 1) {
      const lab = upsert(`strobeLabel${tr.id}`, () => ({
        label: {
          text: "", font: "11px sans-serif", fillColor: COLORS.amber, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
      lab.position = Cesium.Cartesian3.fromRadians(end.lon, end.lat, 100);
      lab.label.text = world.trackName(tr);
      lab._objId = tr.id;
    }
  });
}

/** Point at a bearing and distance from p (radians), on a sphere. */
function offsetLL(p, brg, dist_m) {
  const d = dist_m / 6378140;
  const lat = Math.asin(Math.sin(p.lat) * Math.cos(d) + Math.cos(p.lat) * Math.sin(d) * Math.cos(brg));
  const lon = p.lon + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(p.lat), Math.cos(d) - Math.sin(p.lat) * Math.sin(lat));
  return { lat, lon };
}

/** Dotted plotted-course line with waypoint markers. */
function routeLine(o) {
  const pts = [o, ...o.route].map((p) => Cesium.Cartesian3.fromRadians(p.lon, p.lat, 50));
  const e = upsert(`route${o.id}`, () => ({
    polyline: { positions: [], width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE.withAlpha(0.85), dashLength: 12 }) },
  }));
  setLine(e, pts);
  o.route.forEach((w, i) => {
    const m = upsert(`wp${o.id}-${i}`, () => ({
      point: { pixelSize: 7, color: Cesium.Color.YELLOW, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
    m.position = Cesium.Cartesian3.fromRadians(w.lon, w.lat, 50);
  });
}

/**
 * Hide labels that would overlap a more important one on screen.
 * Priority: selected unit, own ships, own aircraft, then contacts.
 */
const toWindow = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
function declutterLabels() {
  const time = viewer.clock.currentTime;
  const items = [];
  for (const e of entities.values()) {
    if (!e.label || !e.position) continue;
    const key = e._key;
    const prio = e._objId === selectedId ? 0 : key[0] === "o" ? (e.model ? 1 : 2) : 3;
    items.push({ e, prio });
  }
  items.sort((a, b) => a.prio - b.prio);
  const placed = [];
  for (const { e } of items) {
    const p = toWindow(viewer.scene, e.position.getValue(time));
    if (!p) {
      e.label.show = false;
      continue;
    }
    const text = e.label.text.getValue(time) || "";
    const w = 7 * text.length;
    const r = { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - 32, y1: p.y - 16 };
    const clash = placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
    e.label.show = !clash;
    if (!clash) placed.push(r);
  }
}

function renderGlobe() {
  for (const e of entities.values()) e._seen = false;

  const smoking = new Set();
  for (const o of world.objects.values()) {
    // sinking enemy ships stay visible (their tracks are dropped when they sink)
    const sunkEnemy = o.kind === "ship" && o.dead && trackedEnemies.has(o.id);
    if (o.side === PLAYER || showTruth || sunkEnemy) {
      if (o.kind === "ship") {
        shipEntity(`o${o.id}`, o, o.side, false);
        wakeEntity(o);
        effects.shipSmoke(o, Cesium.Cartesian3.fromRadians(o.lon, o.lat, 20));
        smoking.add(o.id);
      } else if (o.kind === "round") roundEntity(`o${o.id}`, o);
      else if (o.kind === "aircraft") airEntity(`o${o.id}`, o, o.side, false);
      else if (!o.dead) missileEntity(`o${o.id}`, o, o.side);
    }
  }
  if (!showTruth) {
    for (const tr of world.tracks[PLAYER].values()) {
      if (tr.bearingOnly) {
        strobes(tr);
        continue;
      }
      const p = predict(tr, world.t);
      const view = { ...tr, ...p };
      if (tr.kind === "ship") {
        shipEntity(`t${tr.id}`, view, tr.side, true);
        // damage is visible on ships held by radar
        const obj = world.get(tr.id);
        if (obj && tr.error_m === 0) {
          effects.shipSmoke(obj, Cesium.Cartesian3.fromRadians(view.lon, view.lat, 20));
          smoking.add(obj.id);
          // remember tracked ships so their sinking can be shown after the track drops
          trackedEnemies.add(obj.id);
        }
        if (tr.error_m > 0) ring(`u${tr.id}`, view, 2 * tr.error_m, COLORS.amber.withAlpha(0.8), true);
      } else if (tr.kind === "aircraft") {
        airEntity(`t${tr.id}`, view, tr.side, true);
      } else {
        missileEntity(`t${tr.id}`, view, tr.side);
      }
    }
  }

  const sel = world.get(selectedId);
  if (sel && !sel.dead && showRings) rangeRings(sel);
  for (const o of world.objects.values()) {
    if (o.side === PLAYER && o.kind === "ship" && !o.dead && o.route.length) routeLine(o);
  }
  const target = world.getTrack(PLAYER, targetId);
  if (target) {
    const p = predict(target, world.t);
    ring("target", p, 3000, COLORS.amber, false);
  } else {
    targetId = null;
  }

  for (const [i, d] of world.detonations.entries()) {
    const dkey = `${d.t}|${d.lat}|${d.lon}`;
    if (!seenDetonations.has(dkey)) {
      seenDetonations.add(dkey);
      effects.explosion(Cesium.Cartesian3.fromRadians(d.lon, d.lat, Math.max(d.alt, 5)), d.big);
    }
    const age = world.t - d.t;
    const e = upsert(`d${d.t}-${i}`, () => ({
      point: { pixelSize: 10, color: COLORS.amber, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
    e.position = pos(d);
    e.point.pixelSize = (d.big ? 26 : 14) * (1 - age / 3) + 4;
    e.point.color = COLORS.amber.withAlpha(Math.max(0, 1 - age / 3));
  }

  for (const [key, e] of [...entities]) {
    if (!e._seen) {
      viewer.entities.remove(e);
      entities.delete(key);
    }
  }
  effects.tidy(smoking);
  if (seenDetonations.size > 2000) seenDetonations.clear();
  declutterLabels();

  const follow = document.getElementById("follow").checked ? entities.get(`o${selectedId}`) : undefined;
  if (viewer.trackedEntity !== follow) viewer.trackedEntity = follow;
}

// ------------------------------------------------------------------ map clicks

function pickLatLon(screenPos) {
  const cart = viewer.camera.pickEllipsoid(screenPos, viewer.scene.globe.ellipsoid);
  if (!cart) return null;
  const c = Cesium.Cartographic.fromCartesian(cart);
  return { lat: c.latitude, lon: c.longitude };
}

const mapClicks = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
mapClicks.setInputAction((click) => {
  // plot course: each click adds a waypoint to the selected ship's route
  if (plotting) {
    const ship = world.get(selectedId);
    const p = pickLatLon(click.position);
    if (ship && ship.kind === "ship" && p) ship.setRoute([...ship.route, p]);
    renderPanels(true);
    return;
  }
  const picked = viewer.scene.pick(click.position);
  const e = picked && picked.id;
  if (!e || e._objId == null) return;
  const o = world.get(e._objId);
  if (o && o.side === PLAYER && (o.kind === "ship" || o.kind === "aircraft")) select(o.id);
  else if (world.getTrack(PLAYER, e._objId)) setTarget(e._objId);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
// right-click ends plotting
mapClicks.setInputAction(() => setPlotting(false), Cesium.ScreenSpaceEventType.RIGHT_CLICK);

// ------------------------------------------------------------------ panels

const $ = (id) => document.getElementById(id);
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const deg3 = (rad) => `${Math.round(((rad / DEG) % 360 + 360) % 360).toString().padStart(3, "0")}°`;
const nm = (m) => `${(m / 1852).toFixed(0)} nm`;

// scenario clock: sim time 0 is the scenario's start time (UTC)
const startMs = Date.parse(scenario.startTime || "2008-06-01T06:00:00Z");
const clockAt = (t) => new Date(startMs + t * 1000);
const hms = (d) => d.toISOString().substr(11, 8);

function select(id) {
  selectedId = id;
  if (plotting && world.get(id)?.kind !== "ship") setPlotting(false);
  statusKey = "";
  renderPanels(true);
}

function setTarget(id) {
  targetId = id;
  statusKey = "";
  renderPanels(true);
}

function setPlotting(on) {
  const ship = world.get(selectedId);
  plotting = on && !!ship && ship.kind === "ship" && !ship.dead;
  $("tPlot").classList.toggle("on", plotting);
  $("hint").style.display = plotting ? "block" : "none";
  $("hint").textContent = plotting
    ? `Plotting course for ${ship.name}: click the map to add waypoints. Right-click or Esc to finish.`
    : "";
  statusKey = "";
}

/** Info bar: date, Zulu and local time, time remaining, camera altitude (CMO-style). */
function renderInfoBar() {
  const now = clockAt(world.t);
  const sel = world.get(selectedId);
  // local time from the selected unit's longitude (15° per hour), else the camera's
  const lon = sel ? sel.lon / DEG : viewer.camera.positionCartographic.longitude / DEG;
  const local = new Date(now.getTime() + Math.round(lon / 15) * 3600e3);
  const date = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  let togo = "";
  if (scenario.endAt_s) {
    const left = Math.max(0, scenario.endAt_s - world.t);
    togo = ` · ${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m to go`;
  }
  const alt = viewer.camera.positionCartographic.height;
  $("timeLine").textContent = `${date} · ${hms(now)}Z · Local ${hms(local)}${togo} · Cam ${alt > 10000 ? `${(alt / 1000).toFixed(0)} km` : `${alt.toFixed(0)} m`}`;
}

/** Left: order of battle (own ships and aircraft). */
function renderOrderOfBattle() {
  const own = [...world.objects.values()].filter((o) => o.side === PLAYER && (o.kind === "ship" || o.kind === "aircraft"));
  const row = (o) => {
    const isAir = o.kind === "aircraft";
    const level = isAir ? o.fuelFraction : 1 - o.damage;
    const color = isAir ? (level < 0.3 ? "var(--amber)" : "var(--blue)") : o.damage > 0.5 ? "var(--red)" : o.damage > 0 ? "var(--amber)" : "var(--green)";
    return `
      <div class="unit ${o.id === selectedId ? "sel" : ""}" data-id="${o.id}">
        <div class="n">${esc(o.name)}${o.dead ? " (sunk)" : ""}</div>
        <div class="c">${esc(o.db.name)}${isAir ? ` · ${o.status}` : ""}</div>
        <div class="bar" title="${isAir ? "fuel" : "condition"}"><i style="width:${100 * level}%;background:${color}"></i></div>
      </div>`;
  };
  const air = own.filter((o) => o.kind === "aircraft");
  $("unitList").innerHTML = own.filter((o) => o.kind === "ship").map(row).join("") +
    (air.length ? `<h2 style="margin-top:10px">Aircraft</h2>${air.map(row).join("")}` : "");
}

/** Weapon status (CMO-style): rounds left by target type and range band. */
function weaponStatus(o) {
  const bands = (km) => (km >= 100 ? "LR" : km >= 20 ? "MR" : "SR");
  const t = { AIR: { LR: 0, MR: 0, SR: 0 }, SURF: { LR: 0, MR: 0, SR: 0 } };
  for (const L of o.launchers) {
    const n = ammoLeft(o, L);
    if (n <= 0) continue;
    const db = L.kind === "gun" ? data.guns[L.item] : data.missiles[L.item];
    if (!db) continue;
    const band = bands(db.maxRange_km);
    const air = L.kind === "gun" ? (db.targetFlags & 10) !== 0 : !isAntiShip(db);
    const surf = L.kind === "gun" ? (db.targetFlags & 1) !== 0 : isAntiShip(db) || (db.targetFlags & 1) !== 0;
    if (air) t.AIR[band] += n;
    if (surf) t.SURF[band] += n;
  }
  return `<table class="wstat"><tr><th></th><th>LR</th><th>MR</th><th>SR</th></tr>${Object.entries(t)
    .map(([k, v]) => `<tr><th>${k}</th><td>${v.LR}</td><td>${v.MR}</td><td>${v.SR}</td></tr>`)
    .join("")}</table>`;
}

/** Right: unit status for the selected own unit, then the selected target and contacts. */
let statusKey = "";
function renderStatus(force = false) {
  const o = world.get(selectedId);
  const contacts = [...world.tracks[PLAYER].values()].filter((t) => t.kind === "ship").sort((a, b) => a.designation.localeCompare(b.designation, undefined, { numeric: true }));
  if (!o) {
    $("status").innerHTML = '<div class="muted">Select one of your units.</div>';
    return;
  }
  const isAir = o.kind === "aircraft";
  const radars = o.radars.filter((r) => r.kind === "radar");
  const radarOn = radars.some((r) => r.active);
  const strikes = world.strikes[PLAYER].map((p, i) => ({ ...p, i })).filter((p) => p.available > 0);
  const asm = isAir ? [] : o.launchers.filter((l) => ammoLeft(o, l) > 0 && isAntiShip(data.missiles[l.item]));
  const tgt = world.getTrack(PLAYER, targetId);
  // rebuild only when the structure changes, so inputs keep focus; numbers update in place below
  const docKey = ["air", "surface", "emcon"].map((k) => `${k}:${o.doctrine?.[k] ?? "-"}:${world.doctrine[PLAYER][k]}`).join();
  const key = [o.id, o.dead, o.status, o.throttle, radarOn, docKey, asm.length, strikes.map((p) => p.available).join(),
    contacts.map((c) => `${c.id}${c.identified ? "i" : ""}${c.bearingOnly ? "b" : ""}${(c.emitters || []).length}`).join(), targetId, tgt?.identified, tgt?.bearingOnly, plotting, o.route?.length].join("|");
  if (!force && key === statusKey) return updateStatusNumbers(o, contacts, tgt);
  statusKey = key;

  const throttle = isAir || o.dead ? "" : `
    <h2>Throttle</h2>
    <div class="seg presets" id="throttle">${["stop", "creep", "cruise", "full", "flank"]
      .map((p) => `<button data-t="${p}" class="${o.throttle === p ? "on" : ""}">${p[0].toUpperCase() + p.slice(1)}</button>`).join("")}</div>
    <div class="orders">
      <label>Course °<input id="oCourse" type="number" min="0" max="359" value="${Math.round(o.goalHeading / DEG)}"></label>
      <label>Speed kts<input id="oSpeed" type="number" min="0" max="${o.db.maxSpeed_kts}" value="${Math.round(o.goalSpeed_kts)}"></label>
      <button id="oGo">Set</button>
    </div>
    <div class="orders">
      <button id="oPlot" class="${plotting ? "on" : ""}">${plotting ? "Plotting… (Esc)" : "Plot course"}</button>
      ${o.route.length ? `<button id="oClear">Clear course (${o.route.length} wp)</button>` : ""}
    </div>`;
  const docRow = (key, label, values) => {
    const own = o.doctrine?.[key];
    const side = world.doctrine[PLAYER][key];
    return `<div class="emcon"><span>${label}</span><div class="seg">
      <button data-doc="${key}" data-v="" class="${own == null ? "on" : ""}" title="Use the side's doctrine">Side (${side})</button>
      ${values.map((v) => `<button data-doc="${key}" data-v="${v}" class="${own === v ? "on" : ""}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}
    </div></div>`;
  };
  const doctrine = o.dead ? "" : `
    <h2>Doctrine</h2>
    ${docRow("air", "Air", ["free", "tight", "hold"])}
    ${isAir ? "" : docRow("surface", "Surface", ["free", "tight", "hold"])}
    ${radars.length && !isAir ? docRow("emcon", "Radar", ["active", "passive"]) : ""}
    ${o.esm?.length ? `<div class="meta">ESM: ${esc(o.esm.map((e) => e.db.name).join(", "))} (passive, always on)</div>` : ""}`;
  const weapons = o.launchers.length ? Object.entries(o.inventory()).map(([k, v]) => `<div>${v}× ${esc(k)}</div>`).join("") : '<div class="muted">No ported weapons</div>';
  const engage = tgt && !o.dead ? `
    <div class="act">
      ${asm.length ? `<button class="fire" data-fire="2">Fire 2 × ${esc(asm[0].item.split(" ")[0])}</button><button class="fire" data-fire="4">Fire 4</button>` : ""}
      <button class="fire" data-group="4" title="Every ship in range fires 4, so they arrive together">All ships: 4 each</button>
      ${strikes.map((p) => `<button class="fire" data-strike="${p.i}" title="${p.count} x ${esc(p.class)}, ${p.available} left">Air strike: ${esc(p.callsign)}</button>`).join("")}
    </div>` : "";

  $("status").innerHTML = `
    <h2>Unit status</h2>
    <h3>${esc(o.name)}</h3>
    <div class="sub">${esc(o.db.name)} · ${esc(o.db.country || "")}${isAir ? ` · ${o.status}` : ""}</div>
    <dl class="grid">
      <dt>Course</dt><dd id="dCourse"></dd>
      <dt>Speed</dt><dd id="dSpeed"></dd>
      ${isAir ? '<dt>Altitude</dt><dd id="dAlt"></dd><dt>Fuel</dt><dd id="dFuel"></dd>' : ""}
      <dt>Damage</dt><dd id="dDamage"></dd>
      <dt>Status</dt><dd id="dState"></dd>
    </dl>
    ${isAir && !o.dead && o.status !== "rtb" ? '<div class="orders"><button id="oRtb">Return to base</button></div>' : ""}
    ${throttle}
    ${doctrine}
    <h2>Weapons</h2>
    <div class="inv" id="dInv">${weapons}</div>
    <div id="dWstat">${weaponStatus(o)}</div>
    <h2>Target</h2>
    ${tgt ? `<div class="target"><span class="hostile">${esc(world.trackName(tgt))}</span><span class="meta" id="dTarget"></span></div>
      <div class="meta">${esc(tgt.bearingOnly ? `${tgt.source}: bearing only. Needs a second bearing from another position, or a radar contact, before weapons can be fired.`
        : tgt.error_m ? `${tgt.source}, ±${(tgt.error_m / 1000).toFixed(1)} km` : tgt.source)}</div>${tgt.bearingOnly ? "" : engage}`
      : '<div class="muted">Click a hostile contact on the map, or pick one below.</div>'}
    <h2>Surface contacts</h2>
    <div id="contacts">${contacts.length ? contacts.map((c) => `
      <div class="contact ${c.id === targetId ? "sel" : ""}" data-target="${c.id}">
        <span class="hostile">${esc(world.trackName(c))}</span><span class="meta" data-meta="${c.id}"></span>
      </div>`).join("") : '<div class="muted">No contacts yet.</div>'}</div>`;
  updateStatusNumbers(o, contacts, tgt);
}

function updateStatusNumbers(o, contacts, tgt) {
  const isAir = o.kind === "aircraft";
  $("dCourse").textContent = deg3(o.heading);
  $("dSpeed").textContent = `${o.speed_kts.toFixed(isAir ? 0 : 1)} kts${o.throttle ? ` (${o.throttle})` : ""}`;
  if (isAir) {
    $("dAlt").textContent = `${Math.round(o.alt)} m`;
    $("dFuel").textContent = pct(o.fuelFraction);
  }
  $("dDamage").textContent = pct(o.damage);
  $("dState").textContent = o.dead ? "Sunk"
    : isAir ? ({ patrol: "On patrol", strike: "Strike mission", rtb: "Returning to base" }[o.status] || o.status)
    : plotting ? "Plotting course"
    : o.route.length ? `On plotted course (${o.route.length} waypoint${o.route.length > 1 ? "s" : ""})` : "Underway";
  $("dInv").innerHTML = Object.entries(o.inventory()).map(([k, v]) => `<div>${v}× ${esc(k)}</div>`).join("") || '<div class="muted">No ported weapons</div>';
  $("dWstat").innerHTML = weaponStatus(o);
  const where = (c) => {
    if (c.bearingOnly) {
      const b = c.bearings[c.bearings.length - 1];
      return `strobe ${deg3(b.brg)} · ${Math.round(world.t - c.t)}s ago`;
    }
    const p = predict(c, world.t);
    return `${deg3(bearing(o, p))} ${nm(groundRange_m(o, p))} · ${Math.round(world.t - c.t)}s ago`;
  };
  if (tgt && $("dTarget")) $("dTarget").textContent = where(tgt);
  for (const c of contacts) {
    const el = document.querySelector(`[data-meta="${c.id}"]`);
    if (el) el.textContent = where(c);
  }
}

function renderPanels(force = false) {
  renderInfoBar();
  renderOrderOfBattle();
  renderStatus(force);
}

$("unitList").addEventListener("click", (ev) => {
  const el = ev.target.closest(".unit");
  if (el) select(Number(el.dataset.id));
});

$("status").addEventListener("click", (ev) => {
  const o = world.get(selectedId);
  if (!o) return;
  const t = ev.target;
  const contact = t.closest(".contact[data-target]");
  if (contact) return setTarget(Number(contact.dataset.target));
  const b = t.closest("button");
  if (!b) return;
  if (b.dataset.t) {
    o.setThrottle(b.dataset.t);
  } else if (b.dataset.doc) {
    world.setDoctrine(PLAYER, b.dataset.doc, b.dataset.v || null, o);
    if (b.dataset.doc === "emcon") {
      world.log(PLAYER, `${o.name}: radars ${world.doc(o, "emcon") === "passive" ? "passive (EMCON)" : "active"}`, "info");
    }
  } else if (b.id === "oGo") {
    o.order({ heading_deg: Number($("oCourse").value), speed_kts: Number($("oSpeed").value) });
  } else if (b.id === "oPlot") {
    setPlotting(!plotting);
  } else if (b.id === "oClear") {
    o.setRoute([]);
  } else if (b.id === "oRtb") {
    o.returnToBase("ordered");
  } else if (b.dataset.strike) {
    const res = world.callStrike(PLAYER, Number(b.dataset.strike), targetId);
    if (!res.ok) world.log(PLAYER, `Cannot launch strike: ${res.reason}`, "info");
  } else if (b.dataset.group) {
    const res = world.orderGroupSalvo(PLAYER, targetId, Number(b.dataset.group));
    world.log(PLAYER, res.ok ? `Coordinated attack: ${res.ships} ships firing` : `Cannot fire: ${res.reason}`, res.ok ? "launch" : "info");
  } else if (b.dataset.fire) {
    const res = world.orderSalvo(o, targetId, Number(b.dataset.fire));
    if (!res.ok) world.log(PLAYER, `${o.name}: cannot fire, ${res.reason}`, "info");
  }
  statusKey = "";
  renderPanels(true);
});

// ------------------------------------------------------------------ message log (grouped)

const LOG_GROUPS = [
  { id: "contacts", name: "Contacts", kinds: ["contact", "threat"] },
  { id: "weapons", name: "Weapons", kinds: ["launch"] },
  { id: "hits", name: "Hits and kills", kinds: ["hit", "kill"] },
  { id: "damage", name: "Damage and losses", kinds: ["damage", "lost"] },
  { id: "misses", name: "Misses and failures", kinds: ["miss"] },
  { id: "info", name: "Other", kinds: ["info"] },
];
const openGroups = new Set(["contacts", "weapons", "hits", "damage"]);
let logSeq = -1;
function renderLog() {
  // the event list is capped, so compare a running counter rather than its length
  if (world.eventSeq === logSeq) return;
  logSeq = world.eventSeq;
  const evs = world.events.filter((e) => e.side === PLAYER);
  $("msgGroups").innerHTML = LOG_GROUPS.map((g) => {
    const list = evs.filter((e) => g.kinds.includes(e.kind)).reverse();
    if (!list.length) return "";
    const open = openGroups.has(g.id);
    return `<div class="lg">
      <div class="lg-head" data-g="${g.id}">${open ? "▾" : "▸"} ${g.name} (${list.length})</div>
      ${open ? list.slice(0, 60).map((e) => `<div class="ev ${e.kind}"><span>${esc(e.text)}</span><time>${hms(clockAt(e.t))}</time></div>`).join("") : ""}
    </div>`;
  }).join("") || '<div class="muted">Nothing yet.</div>';
}
$("msgGroups").addEventListener("click", (ev) => {
  const h = ev.target.closest(".lg-head");
  if (!h) return;
  if (openGroups.has(h.dataset.g)) openGroups.delete(h.dataset.g);
  else openGroups.add(h.dataset.g);
  logSeq = -1;
  renderLog();
});

// ------------------------------------------------------------------ losses & expenditures

function lossesReport() {
  const sideBlock = (side, label) => {
    const st = world.stats[side];
    const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div>${v}× ${esc(k)}</div>`).join("") || '<div class="muted">None</div>';
    return `<section><h3 class="side-${side}">${label}</h3><h2>Losses</h2>${list(st.lost)}<h2>Expenditures</h2>${list(st.expended)}</section>`;
  };
  $("modalBody").innerHTML = `<div class="two-col">${sideBlock("blue", "Blue (you)")}${sideBlock("red", "Red")}</div>`;
  $("modalTitle").textContent = "Losses & Expenditures";
  $("modal").hidden = false;
}
$("modalClose").onclick = () => ($("modal").hidden = true);

/** Side-wide doctrine for the player's side. */
function doctrineWindow() {
  const d = world.doctrine[PLAYER];
  const row = (key, label, values, help) => `
    <div class="emcon"><span>${label}</span><div class="seg">${values
      .map((v) => `<button data-sdoc="${key}" data-v="${v}" class="${d[key] === v ? "on" : ""}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div></div>
    <div class="meta" style="margin:-6px 0 12px">${help}</div>`;
  $("modalTitle").textContent = "Doctrine (your side)";
  $("modalBody").innerHTML = `
    ${row("air", "Air", ["free", "tight", "hold"], "Engage aircraft: Free any, Tight only identified, Hold never. Inbound missiles are always engaged.")}
    ${row("surface", "Surface", ["free", "tight", "hold"], "Free and Tight: your ships fire anti-ship missiles and guns at enemy ships on their own (Tight: identified only). Hold: only when you order it.")}
    ${row("emcon", "Radar", ["active", "passive"], "Passive: all your ships' radars off. They can't be found by enemy ESM, but can only see with lookouts and ESM.")}
    <div class="meta">Individual units can override these in their Doctrine section.</div>`;
  $("modal").hidden = false;
}
$("modalBody").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-sdoc]");
  if (!b) return;
  world.setDoctrine(PLAYER, b.dataset.sdoc, b.dataset.v);
  world.log(PLAYER, `Doctrine: ${b.dataset.sdoc} ${b.dataset.v}`, "info");
  doctrineWindow();
  statusKey = "";
});

// ------------------------------------------------------------------ toolbar, keys, loop

let timeScale = 15;
let running = false;

function setSpeed(s) {
  timeScale = s;
  for (const x of $("speed").children) x.classList.toggle("on", Number(x.dataset.s) === s);
}
$("speed").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (b) setSpeed(Number(b.dataset.s));
});
$("tPlot").onclick = () => setPlotting(!plotting);
$("tRings").onclick = () => {
  showRings = !showRings;
  $("tRings").classList.toggle("on", showRings);
};
$("tLosses").onclick = lossesReport;
$("tDoctrine").onclick = doctrineWindow;
$("tLog").onclick = () => {
  const el = $("msglog");
  el.hidden = !el.hidden;
  $("tLog").classList.toggle("on", !el.hidden);
};
$("truth").addEventListener("change", (ev) => {
  showTruth = ev.target.checked;
});

document.addEventListener("keydown", (ev) => {
  if (ev.target.matches("input, textarea, select")) return;
  const k = ev.key.toLowerCase();
  if (k === "escape") {
    setPlotting(false);
    $("modal").hidden = true;
  } else if (k === "p") setPlotting(!plotting);
  else if (k === "r") $("tRings").click();
  else if (k === "l") lossesReport();
  else if (k === "d") doctrineWindow();
  else if (k === "m") $("tLog").click();
  else if (k === " ") {
    ev.preventDefault();
    setSpeed(timeScale ? 0 : 15);
  } else if ("123456".includes(k)) setSpeed([1, 5, 15, 30, 60, 120][Number(k) - 1]);
});

$("title").textContent = scenario.name;
$("briefTitle").textContent = scenario.name;
$("briefText").textContent = scenario.description;
$("start").onclick = () => {
  $("brief").style.display = "none";
  running = true;
};

// scenario picker (built-in and saved in this browser): reload with ?scenario=<id>
listScenarios().then((list) => {
  $("scenarioPick").innerHTML = list
    .map((s) => `<option value="${esc(s.id)}" ${s.id === scenarioName ? "selected" : ""}>${esc(s.name)}</option>`)
    .join("");
  $("scenarioPick").onchange = (ev) => {
    location.search = `?scenario=${encodeURIComponent(ev.target.value)}`;
  };
});
$("editLink").href = `editor.html?scenario=${encodeURIComponent(scenarioName)}`;

let last = performance.now();
let acc = 0;
let lastPanel = 0;
let endShown = false;
function frame(now) {
  const real = Math.min((now - last) / 1000, 0.25);
  last = now;
  if (running && !world.over) {
    acc += real * timeScale;
    let n = 0;
    while (acc >= SIM_DT && n < MAX_STEPS_PER_FRAME) {
      world.step(SIM_DT);
      acc -= SIM_DT;
      n++;
    }
    if (n === MAX_STEPS_PER_FRAME) acc = 0;
  }
  renderGlobe();
  if (now - lastPanel > 200) {
    lastPanel = now;
    renderPanels();
    renderLog();
    if (world.over && !endShown) {
      endShown = true;
      $("banner").style.display = "block";
      if (world.over.loser == null) {
        // time limit: report losses on both sides
        const all = [...world.objects.values()].filter((o) => o.kind === "ship");
        const lost = (side) => all.filter((o) => o.side === side && o.dead).length;
        const own = all.filter((o) => o.side === PLAYER);
        $("banner").textContent = `Time up: ${own.length - lost(PLAYER)} of ${own.length} ships afloat, ${lost("red")} enemy ships sunk`;
        $("banner").style.color = lost(PLAYER) ? "var(--amber)" : "var(--green)";
      } else {
        const won = world.over.loser !== PLAYER;
        $("banner").textContent = won ? "Victory: hostile force destroyed" : "Defeat: your force has been sunk";
        $("banner").style.color = won ? "var(--green)" : "var(--red)";
      }
      lossesReport();
    }
  }
  requestAnimationFrame(frame);
}
renderPanels(true);
requestAnimationFrame(frame);

window.world = world; // for debugging in the console
