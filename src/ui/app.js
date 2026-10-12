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
let showTruth = false;

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
  if (e.model) e.model.show = (!isTrack || o.error_m === 0) && sink < 1;
  e.label.text = isTrack ? `${o.className}${o.error_m ? " (reported)" : ""}` : `${o.name}${dead ? " (sunk)" : ""}`;
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
  e.label.text = `${isTrack ? o.className : o.name}  FL${String(Math.round(o.alt / 30.48)).padStart(3, "0")}`;
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
  if (sel && !sel.dead) {
    const rings = sel.radars.filter((r) => r.active).map((r) => r.nominalRange_km(40, 10));
    if (rings.length) ring("radar", sel, 1000 * Math.max(...rings), COLORS.blue.withAlpha(0.6), false);
    const asm = sel.launchers.filter((l) => ammoLeft(sel, l) > 0 && isAntiShip(data.missiles[l.item]));
    if (asm.length) ring("asm", sel, 1000 * Math.max(...asm.map((l) => data.missiles[l.item].maxRange_km)), COLORS.amber.withAlpha(0.5), true);
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

// picking: click a friendly ship or aircraft to select it
new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  const e = picked && picked.id;
  if (e && e._objId != null) {
    const o = world.get(e._objId);
    if (o && o.side === PLAYER && (o.kind === "ship" || o.kind === "aircraft")) select(o.id);
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ------------------------------------------------------------------ panels

const $ = (id) => document.getElementById(id);
const fmtTime = (t) => new Date(t * 1000).toISOString().substr(11, 8);
const pct = (x) => `${Math.round(x * 100)}%`;

function select(id) {
  selectedId = id;
  detailKey = "";
  renderPanels(true);
}

let detailKey = "";
function renderPanels(force = false) {
  $("clock").textContent = fmtTime(world.t);

  const own = [...world.objects.values()].filter((o) => o.side === PLAYER && (o.kind === "ship" || o.kind === "aircraft"));
  const unitRow = (o) => {
    const isAir = o.kind === "aircraft";
    const level = isAir ? o.fuelFraction : 1 - o.damage;
    const color = isAir ? (level < 0.3 ? "var(--amber)" : "var(--blue)") : o.damage > 0.5 ? "var(--red)" : o.damage > 0 ? "var(--amber)" : "var(--green)";
    return `
      <div class="unit ${o.id === selectedId ? "sel" : ""}" data-id="${o.id}">
        <div class="n">${o.name}${o.dead ? " — sunk" : ""}</div>
        <div class="c">${o.db.name}${isAir ? ` · ${o.status}` : ""}</div>
        <div class="bar" title="${isAir ? "fuel" : "condition"}"><i style="width:${100 * level}%;background:${color}"></i></div>
      </div>`;
  };
  const ownAir = own.filter((o) => o.kind === "aircraft");
  $("unitList").innerHTML =
    own.filter((o) => o.kind === "ship").map(unitRow).join("") +
    (ownAir.length ? `<h2 style="margin-top:10px">Aircraft</h2>${ownAir.map(unitRow).join("")}` : "");

  let o = world.get(selectedId);
  if (!o) {
    // selected aircraft left the area or was lost: fall back to the first ship
    o = own.find((u) => u.kind === "ship");
    if (!o) return;
    selectedId = o.id;
    force = true;
  }
  const isAir = o.kind === "aircraft";
  const contacts = [...world.tracks[PLAYER].values()].filter((t) => t.kind === "ship");
  const strikes = world.strikes[PLAYER].map((p, i) => ({ ...p, i })).filter((p) => p.available > 0);
  // rebuild the detail panel only when its structure changes, so inputs keep focus
  // anti-ship stock decides whether fire buttons show; other counts are updated in place below
  const asmLeft = o.launchers.filter((l) => ammoLeft(o, l) > 0 && isAntiShip(data.missiles[l.item])).length;
  const key = [o.id, o.dead, contacts.map((c) => c.id).join(","), asmLeft, strikes.map((p) => p.available).join(","), o.status].join("|");
  if (force || key !== detailKey) {
    detailKey = key;
    const asm = isAir ? [] : o.launchers.filter((l) => ammoLeft(o, l) > 0 && isAntiShip(data.missiles[l.item]));
    $("detail").innerHTML = `
      <h3>${o.name}</h3>
      <div class="sub">${o.db.name} · ${o.db.country}${isAir ? ` · ${o.status}` : ""}</div>
      <dl class="grid">
        <dt>Course</dt><dd id="dCourse"></dd>
        <dt>Speed</dt><dd id="dSpeed"></dd>
        ${isAir ? '<dt>Altitude</dt><dd id="dAlt"></dd><dt>Fuel</dt><dd id="dFuel"></dd>' : ""}
        <dt>Damage</dt><dd id="dDamage"></dd>
        <dt>Radars</dt><dd>${o.radars.map((r) => r.db.name).join(", ") || "none"}</dd>
      </dl>
      ${o.dead ? "" : isAir ? (o.status === "rtb" ? "" : `
      <h2>Orders</h2>
      <div class="orders"><button id="oRtb">Return to base</button></div>`) : `
      <h2>Orders</h2>
      <div class="orders">
        <label>Course °<input id="oCourse" type="number" min="0" max="359" value="${Math.round(o.goalHeading / DEG)}"></label>
        <label>Speed kts<input id="oSpeed" type="number" min="0" max="${o.db.maxSpeed_kts}" value="${Math.round(o.goalSpeed_kts)}"></label>
        <button id="oGo">Set</button>
      </div>`}
      <h2>Weapons</h2>
      <div class="inv" id="dInv"></div>
      <h2>Hostile surface contacts</h2>
      <div id="contacts">${contacts.length ? "" : '<div class="muted">No contacts yet.</div>'}</div>
    `;
    $("contacts").innerHTML += contacts.map((c) => `
      <div class="contact" data-id="${c.id}">
        <div class="top"><span class="hostile">${c.className}</span><span class="meta" data-meta="${c.id}"></span></div>
        <div class="meta">${c.error_m ? `${c.source}, ±${(c.error_m / 1000).toFixed(1)} km` : c.source}</div>
        ${!o.dead && asm.length ? `<div class="act">
          <button class="fire" data-fire="2" data-target="${c.id}">Fire 2 × ${asm[0].item.split(" ")[0]}</button>
          <button class="fire" data-fire="4" data-target="${c.id}">Fire 4</button>
          <button class="fire" data-group="4" data-target="${c.id}" title="Every ship in range fires 4, so they arrive together">All ships: 4 each</button>
        </div>` : ""}
        ${strikes.length ? `<div class="act">${strikes.map((p) => `
          <button class="fire" data-strike="${p.i}" data-target="${c.id}" title="${p.count} x ${p.class} from off-map, ${p.available} package(s) left">Air strike: ${p.callsign}</button>`).join("")}
        </div>` : ""}
      </div>`).join("");
    if ($("oGo")) {
      $("oGo").onclick = () => {
        o.order({ heading_deg: Number($("oCourse").value), speed_kts: Number($("oSpeed").value) });
      };
    }
    if ($("oRtb")) $("oRtb").onclick = () => o.returnToBase("ordered");
  }
  $("dCourse").textContent = `${Math.round(o.heading / DEG).toString().padStart(3, "0")}°`;
  $("dSpeed").textContent = `${o.speed_kts.toFixed(isAir ? 0 : 1)} kts`;
  if (isAir) {
    $("dAlt").textContent = `${Math.round(o.alt)} m`;
    $("dFuel").textContent = pct(o.fuelFraction);
  }
  $("dDamage").textContent = pct(o.damage);
  $("dInv").innerHTML = Object.entries(o.inventory()).map(([k, v]) => `${k}: ${v}`).join("<br>");
  for (const c of contacts) {
    const el = document.querySelector(`[data-meta="${c.id}"]`);
    if (!el) continue;
    const p = predict(c, world.t);
    el.textContent = `${Math.round(bearing(o, p) / DEG).toString().padStart(3, "0")}° ${(groundRange_m(o, p) / 1852).toFixed(0)} nm · ${Math.round(world.t - c.t)}s ago`;
  }
}

$("unitList").addEventListener("click", (ev) => {
  const el = ev.target.closest(".unit");
  if (el) select(Number(el.dataset.id));
});

$("detail").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-fire], button[data-group], button[data-strike]");
  if (!b) return;
  const o = world.get(selectedId);
  const target = Number(b.dataset.target);
  if (b.dataset.strike) {
    const res = world.callStrike(PLAYER, Number(b.dataset.strike), target);
    if (!res.ok) world.log(PLAYER, `Cannot launch strike: ${res.reason}`, "info");
    return;
  }
  if (b.dataset.group) {
    const res = world.orderGroupSalvo(PLAYER, target, Number(b.dataset.group));
    if (!res.ok) world.log(PLAYER, `Cannot fire: ${res.reason}`, "info");
    else world.log(PLAYER, `Coordinated attack: ${res.ships} ships firing`, "launch");
    return;
  }
  const res = world.orderSalvo(o, target, Number(b.dataset.fire));
  if (!res.ok) world.log(PLAYER, `${o.name}: cannot fire, ${res.reason}`, "info");
});

let logSeq = -1;
function renderLog() {
  // the event list is capped, so compare a running counter rather than its length
  if (world.eventSeq === logSeq) return;
  logSeq = world.eventSeq;
  const evs = world.events.filter((e) => e.side === PLAYER);
  const el = $("log");
  el.innerHTML = evs.slice(-200).map((e) => `<div class="ev ${e.kind}">${fmtTime(e.t)}  ${e.text}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

// ------------------------------------------------------------------ controls & loop

let timeScale = 20;
let running = false;

$("speed").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  timeScale = Number(b.dataset.s);
  for (const x of $("speed").children) x.classList.toggle("on", x === b);
});
$("truth").addEventListener("change", (ev) => {
  showTruth = ev.target.checked;
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
    .map((s) => `<option value="${s.id}" ${s.id === scenarioName ? "selected" : ""}>${s.name}</option>`)
    .join("");
  $("scenarioPick").onchange = (ev) => {
    location.search = `?scenario=${encodeURIComponent(ev.target.value)}`;
  };
});
$("editLink").href = `editor.html?scenario=${encodeURIComponent(scenarioName)}`;

let last = performance.now();
let acc = 0;
let lastPanel = 0;
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
    if (world.over) {
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
    }
  }
  requestAnimationFrame(frame);
}
renderPanels(true);
requestAnimationFrame(frame);

window.world = world; // for debugging in the console
