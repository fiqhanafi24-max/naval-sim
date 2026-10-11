// Browser front end: CesiumJS globe + DOM panels around the headless World.
/* global Cesium */

import { World, isAntiShip } from "../sim/world.js";
import { predict } from "../sim/missile.js";
import { DEG, bearing, groundRange_m } from "../sim/geo.js";

const PLAYER = "blue";
const SIM_DT = 0.1;
const MAX_STEPS_PER_FRAME = 1200;

const params = new URLSearchParams(location.search);
const scenarioName = params.get("scenario") || "norwegian-sea";

const [data, atmo, scenario] = await Promise.all([
  fetch("data/gcb-units.json").then((r) => r.json()),
  fetch("data/atmosphere.csv").then((r) => r.text()),
  fetch(`scenarios/${scenarioName}.json`).then((r) => r.json()),
]);

const world = new World(data, atmo, scenario);

// ------------------------------------------------------------------ globe

const viewer = new Cesium.Viewer("globe", {
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")),
  ),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0b2a4a");
viewer.scene.globe.showGroundAtmosphere = true;

const cam = scenario.camera || {};
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(cam.lon_deg ?? 0, cam.lat_deg ?? 0, cam.alt_m ?? 200000),
  orientation: { heading: 0, pitch: (cam.pitch_deg ?? -60) * DEG, roll: 0 },
});

const COLORS = {
  blue: Cesium.Color.fromCssColorString("#4da3ff"),
  red: Cesium.Color.fromCssColorString("#ff5a52"),
  amber: Cesium.Color.fromCssColorString("#ffb547"),
  white: Cesium.Color.WHITE,
};

/** NTDS-style symbols drawn on canvas: friendly = circle/square, hostile = diamond. */
function symbol(side, kind) {
  const c = document.createElement("canvas");
  const s = kind === "ship" ? 28 : 16;
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.lineWidth = kind === "ship" ? 2.5 : 2;
  g.strokeStyle = side === PLAYER ? "#4da3ff" : "#ff5a52";
  g.fillStyle = side === PLAYER ? "rgba(77,163,255,0.25)" : "rgba(255,90,82,0.25)";
  g.beginPath();
  const m = s / 2;
  const r = s / 2 - 3;
  if (side === PLAYER) {
    if (kind === "ship") g.arc(m, m, r, 0, Math.PI * 2);
    else g.rect(m - r, m - r, 2 * r, 2 * r);
  } else {
    g.moveTo(m, m - r); g.lineTo(m + r, m); g.lineTo(m, m + r); g.lineTo(m - r, m); g.closePath();
  }
  g.fill();
  g.stroke();
  return c;
}
const SYMBOLS = {};
for (const side of ["blue", "red"]) for (const kind of ["ship", "missile"]) SYMBOLS[`${side}-${kind}`] = symbol(side, kind);

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

let selectedId = world.ships(PLAYER)[0]?.id ?? null;
let showTruth = false;

function shipEntity(key, o, side, isTrack) {
  const e = upsert(key, () => ({
    billboard: { image: SYMBOLS[`${side}-ship`], verticalOrigin: Cesium.VerticalOrigin.CENTER, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: {
      text: "", font: "12px sans-serif", fillColor: COLORS[side], outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -24),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    box: { dimensions: new Cesium.Cartesian3(1, 1, 1), material: COLORS[side].withAlpha(0.9), outline: false },
  }));
  e.position = pos(o, 0);
  const hpr = new Cesium.HeadingPitchRoll(o.heading - Math.PI / 2, 0, 0);
  e.orientation = Cesium.Transforms.headingPitchRollQuaternion(pos(o), hpr);
  const db = data.ships[o.className || o.db?.name];
  if (db) e.box.dimensions = new Cesium.Cartesian3(db.length_m, Math.max(db.beam_m, 8), 2 * db.effectiveHeight_m);
  e.box.show = !isTrack || o.error_m === 0;
  const dead = o.dead;
  e.label.text = isTrack ? `${o.className}${o.error_m ? " (reported)" : ""}` : `${o.name}${dead ? " (sunk)" : ""}`;
  e.billboard.color = dead ? Cesium.Color.GRAY : Cesium.Color.WHITE;
  e._objId = o.id;
  return e;
}

function missileEntity(key, o, side) {
  const e = upsert(key, () => ({
    billboard: { image: SYMBOLS[`${side}-missile`], disableDepthTestDistance: Number.POSITIVE_INFINITY },
    polyline: { positions: [], width: 1.5, material: COLORS[side].withAlpha(0.7) },
  }));
  e.position = pos(o);
  if (o.trail) e.polyline.positions = [...o.trail.map((p) => pos(p)), pos(o)];
  e._objId = o.id;
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
    pts.push(Cesium.Cartesian3.fromRadians(lon, lat, 30));
  }
  e.polyline.positions = pts;
}

function renderGlobe() {
  for (const e of entities.values()) e._seen = false;

  for (const o of world.objects.values()) {
    if (o.side === PLAYER || showTruth) {
      if (o.kind === "ship") shipEntity(`o${o.id}`, o, o.side, false);
      else if (!o.dead) missileEntity(`o${o.id}`, o, o.side);
    }
  }
  if (!showTruth) {
    for (const tr of world.tracks[PLAYER].values()) {
      const p = predict(tr, world.t);
      const view = { ...tr, ...p };
      if (tr.kind === "ship") {
        shipEntity(`t${tr.id}`, view, tr.side, true);
        if (tr.error_m > 0) ring(`u${tr.id}`, view, 2 * tr.error_m, COLORS.amber.withAlpha(0.8), true);
      } else {
        missileEntity(`t${tr.id}`, view, tr.side);
      }
    }
  }

  const sel = world.get(selectedId);
  if (sel && !sel.dead) {
    const rings = sel.radars.filter((r) => r.active).map((r) => r.nominalRange_km(40, 10));
    if (rings.length) ring("radar", sel, 1000 * Math.max(...rings), COLORS.blue.withAlpha(0.6), false);
    const asm = sel.launchers.filter((l) => l.count > 0 && isAntiShip(data.missiles[l.item]));
    if (asm.length) ring("asm", sel, 1000 * Math.max(...asm.map((l) => data.missiles[l.item].maxRange_km)), COLORS.amber.withAlpha(0.5), true);
  }

  for (const [i, d] of world.detonations.entries()) {
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

  const follow = document.getElementById("follow").checked ? entities.get(`o${selectedId}`) : undefined;
  if (viewer.trackedEntity !== follow) viewer.trackedEntity = follow;
}

// picking: click a friendly ship to select it
new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  const e = picked && picked.id;
  if (e && e._objId != null) {
    const o = world.get(e._objId);
    if (o && o.side === PLAYER && o.kind === "ship") select(o.id);
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

  $("unitList").innerHTML = [...world.objects.values()]
    .filter((o) => o.kind === "ship" && o.side === PLAYER)
    .map((o) => `
      <div class="unit ${o.id === selectedId ? "sel" : ""}" data-id="${o.id}">
        <div class="n">${o.name}${o.dead ? " — sunk" : ""}</div>
        <div class="c">${o.db.name}</div>
        <div class="bar"><i style="width:${100 - o.damage * 100}%;background:${o.damage > 0.5 ? "var(--red)" : o.damage > 0 ? "var(--amber)" : "var(--green)"}"></i></div>
      </div>`)
    .join("");

  const o = world.get(selectedId);
  if (!o) return;
  const contacts = [...world.tracks[PLAYER].values()].filter((t) => t.kind === "ship");
  // rebuild the detail panel only when its structure changes, so inputs keep focus
  const key = [o.id, o.dead, contacts.map((c) => c.id).join(","), Object.values(o.inventory()).join(",")].join("|");
  if (force || key !== detailKey) {
    detailKey = key;
    const asm = o.launchers.filter((l) => l.count > 0 && isAntiShip(data.missiles[l.item]));
    $("detail").innerHTML = `
      <h3>${o.name}</h3>
      <div class="sub">${o.db.name} · ${o.db.country}</div>
      <dl class="grid">
        <dt>Course</dt><dd id="dCourse"></dd>
        <dt>Speed</dt><dd id="dSpeed"></dd>
        <dt>Damage</dt><dd id="dDamage"></dd>
        <dt>Radars</dt><dd>${o.radars.map((r) => r.db.name).join(", ")}</dd>
      </dl>
      ${o.dead ? "" : `
      <h2>Orders</h2>
      <div class="orders">
        <label>Course °<input id="oCourse" type="number" min="0" max="359" value="${Math.round(o.goalHeading / DEG)}"></label>
        <label>Speed kts<input id="oSpeed" type="number" min="0" max="${o.db.maxSpeed_kts}" value="${Math.round(o.goalSpeed_kts)}"></label>
        <button id="oGo">Set</button>
      </div>`}
      <h2>Weapons</h2>
      <div class="inv">${Object.entries(o.inventory()).map(([k, v]) => `${k}: ${v}`).join("<br>")}</div>
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
        </div>` : ""}
      </div>`).join("");
    if ($("oGo")) {
      $("oGo").onclick = () => {
        o.order({ heading_deg: Number($("oCourse").value), speed_kts: Number($("oSpeed").value) });
      };
    }
  }
  $("dCourse").textContent = `${Math.round(o.heading / DEG).toString().padStart(3, "0")}°`;
  $("dSpeed").textContent = `${o.speed_kts.toFixed(1)} kts`;
  $("dDamage").textContent = pct(o.damage);
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
  const b = ev.target.closest("button[data-fire]");
  if (!b) return;
  const o = world.get(selectedId);
  const res = world.orderSalvo(o, Number(b.dataset.target), Number(b.dataset.fire));
  if (!res.ok) world.log(PLAYER, `${o.name}: cannot fire, ${res.reason}`, "info");
});

let logCount = -1;
function renderLog() {
  const evs = world.events.filter((e) => e.side === PLAYER);
  if (evs.length === logCount) return;
  logCount = evs.length;
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
      const won = world.over.loser !== PLAYER;
      $("banner").style.display = "block";
      $("banner").textContent = won ? "Victory: hostile force destroyed" : "Defeat: your force has been sunk";
      $("banner").style.color = won ? "var(--green)" : "var(--red)";
    }
  }
  requestAnimationFrame(frame);
}
renderPanels(true);
requestAnimationFrame(frame);

window.world = world; // for debugging in the console
