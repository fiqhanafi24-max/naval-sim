// Scenario editor: place ships, patrol flights and strike packages anywhere on the globe,
// set scenario options, save to this browser or a file, and play.
/* global Cesium */

import { DEG } from "../sim/geo.js";
import { COLORS, SYMBOLS, createViewer, listScenarios, loadScenario, saveLocalScenario } from "./common.js";

const $ = (id) => document.getElementById(id);
const data = await fetch("data/gcb-units.json").then((r) => r.json());
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ scenario model

function blankScenario() {
  return {
    name: "New scenario",
    description: "",
    seed: Math.floor(Math.random() * 100000),
    endAt_s: 7200,
    camera: { lat_deg: 30, lon_deg: 0, alt_m: 3000000, pitch_deg: -70 },
    units: [],
    air: [],
    strikes: { blue: [], red: [] },
    intel: {},
    ai: { blue: { autoDefend: true, weaponsFree: false }, red: { autoDefend: true, weaponsFree: true, salvo: 4 } },
  };
}

/** Fill in any sections a loaded scenario lacks, so the editor can rely on them. */
function normalize(s) {
  const b = blankScenario();
  return {
    ...b,
    ...s,
    air: s.air || [],
    intel: { ...(s.intel || {}) },
    strikes: { blue: [], red: [], ...(s.strikes || {}) },
    ai: { blue: { ...b.ai.blue, ...(s.ai?.blue || {}) }, red: { ...b.ai.red, ...(s.ai?.red || {}) } },
  };
}

let scenario = blankScenario();
let localId = null; // id under which this scenario is saved in the browser
const startId = params.get("scenario");
if (startId) {
  try {
    scenario = normalize(await loadScenario(startId));
    if (startId.startsWith("local:")) localId = startId.slice(6);
  } catch (e) {
    alert(e.message);
  }
}

const viewer = createViewer("globe", scenario.camera);

/**
 * Editor items wrap the three kinds of scenario entries so they can be listed, selected and
 * moved uniformly: {type: "ship"|"patrol"|"strike", ref: the scenario object}.
 */
function items() {
  return [
    ...scenario.units.map((ref) => ({ type: "ship", ref, side: ref.side })),
    ...scenario.air.map((ref) => ({ type: "patrol", ref, side: ref.side })),
    ...["blue", "red"].flatMap((side) => scenario.strikes[side].map((ref) => ({ type: "strike", ref, side }))),
  ];
}

function itemPos(it) {
  const r = it.ref;
  if (it.type === "strike") return { lat_deg: r.from.lat_deg, lon_deg: r.from.lon_deg };
  return { lat_deg: r.lat_deg, lon_deg: r.lon_deg };
}

function moveItem(it, lat_deg, lon_deg) {
  const r = it.ref;
  if (it.type === "strike") {
    r.from = { lat_deg, lon_deg };
  } else if (it.type === "patrol") {
    r.lat_deg = lat_deg;
    r.lon_deg = lon_deg;
    r.home = { lat_deg, lon_deg };
    r.mission.center = { lat_deg, lon_deg };
  } else {
    r.lat_deg = lat_deg;
    r.lon_deg = lon_deg;
  }
}

function removeItem(it) {
  const list = it.type === "ship" ? scenario.units : it.type === "patrol" ? scenario.air : scenario.strikes[it.side];
  list.splice(list.indexOf(it.ref), 1);
}

// ------------------------------------------------------------------ catalogue

let side = "blue";
let kind = "ship";
let placing = null; // catalogue class name being placed
let selected = null; // scenario object (item.ref) being edited

function weaponsSummary(db) {
  const counts = {};
  for (const l of db.launchers) {
    const n = l.count + ((db.magazine || {})[l.item] || 0);
    const short = l.item.replace(/ (Harpoon|Exocet|Moskit-M|Termit)$/, "").split(" ")[0];
    counts[short] = (counts[short] || 0) + n;
  }
  return Object.entries(counts)
    .slice(0, 5)
    .map(([k, v]) => `${v}×${k}`)
    .join(", ") || "no ported weapons";
}

function catalogueEntries() {
  if (kind === "ship") return Object.values(data.ships);
  return Object.values(data.aircraft).filter((a) => a.role === kind);
}

function renderCatalogue() {
  const q = $("search").value.trim().toLowerCase();
  const list = catalogueEntries()
    .filter((d) => !q || `${d.name} ${d.country} ${d.year ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
  $("results").innerHTML = list.length
    ? list.map((d) => `
      <div class="cat-item ${placing === d.name ? "sel" : ""}" data-name="${escapeAttr(d.name)}">
        <div class="n">${escapeHtml(d.name)}</div>
        <div class="m">${escapeHtml(d.country || "")}${d.year ? ` · ${d.year}` : ""} · ${
          kind === "patrol" ? (d.sensors.map((s) => s.name).join(", ") || "no radar") : escapeHtml(weaponsSummary(d))
        }</div>
      </div>`).join("")
    : '<div class="muted">Nothing matches.</div>';
}

$("results").addEventListener("click", (ev) => {
  const el = ev.target.closest(".cat-item");
  if (!el) return;
  placing = placing === el.dataset.name ? null : el.dataset.name;
  renderCatalogue();
  updateHint();
});
$("search").addEventListener("input", renderCatalogue);
segmented("sidePick", "side", (v) => {
  side = v;
  updateHint();
});
segmented("kindPick", "kind", (v) => {
  kind = v;
  placing = null;
  renderCatalogue();
  updateHint();
});

function segmented(id, key, onPick) {
  $(id).addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    for (const x of $(id).children) x.classList.toggle("on", x === b);
    onPick(b.dataset[key]);
  });
}

function updateHint() {
  const h = $("hint");
  if (placing) {
    const what = kind === "ship" ? "ship" : kind === "patrol" ? "patrol flight (it orbits where you place it)" : "strike package launch point";
    h.innerHTML = `Click the map to place a <b class="side-${side}">${side}</b> ${escapeHtml(placing)} ${what}. Esc to stop.`;
    h.style.display = "block";
  } else {
    h.style.display = "none";
  }
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    placing = null;
    renderCatalogue();
    updateHint();
  }
});

// ------------------------------------------------------------------ placing and moving on the globe

function pickLatLon(screenPos) {
  const cart = viewer.camera.pickEllipsoid(screenPos, viewer.scene.globe.ellipsoid);
  if (!cart) return null;
  const c = Cesium.Cartographic.fromCartesian(cart);
  return { lat_deg: +(c.latitude / DEG).toFixed(4), lon_deg: +(c.longitude / DEG).toFixed(4) };
}

let counter = 1;
function placeAt(p) {
  if (kind === "ship") {
    const ref = { side, class: placing, name: `${side === "blue" ? "Blue" : "Red"} ${placing.split(" ")[0]} ${counter++}`,
      lat_deg: p.lat_deg, lon_deg: p.lon_deg, heading_deg: 0, speed_kts: 15 };
    scenario.units.push(ref);
    select(ref);
  } else if (kind === "patrol") {
    const ref = { side, class: placing, name: `${placing.split(" ")[0]} ${counter++}`, lat_deg: p.lat_deg, lon_deg: p.lon_deg,
      alt_m: 6000, heading_deg: 0, home: { ...p }, mission: { type: "patrol", center: { ...p }, radius_km: 25, alt_m: 6000 } };
    scenario.air.push(ref);
    select(ref);
  } else {
    const ref = { callsign: `${placing.split(" ")[0]} strike ${counter++}`, class: placing, count: 2, available: 1,
      alt_m: 3000, launchFraction: 0.6, notBefore_s: 0, from: { ...p } };
    scenario.strikes[side].push(ref);
    select(ref);
  }
}

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
let dragging = null;
handler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  const ref = picked?.id?._ref;
  if (ref && !placing) return select(ref);
  const p = pickLatLon(click.position);
  if (p && placing) placeAt(p);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// drag a placed unit to move it
handler.setInputAction((down) => {
  const picked = viewer.scene.pick(down.position);
  const ref = picked?.id?._ref;
  if (!ref || placing) return;
  dragging = items().find((it) => it.ref === ref);
  select(ref);
  viewer.scene.screenSpaceCameraController.enableInputs = false;
}, Cesium.ScreenSpaceEventType.LEFT_DOWN);
handler.setInputAction((move) => {
  if (!dragging) return;
  const p = pickLatLon(move.endPosition);
  if (p) {
    moveItem(dragging, p.lat_deg, p.lon_deg);
    renderGlobe();
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
handler.setInputAction(() => {
  if (!dragging) return;
  dragging = null;
  viewer.scene.screenSpaceCameraController.enableInputs = true;
  renderInspector();
}, Cesium.ScreenSpaceEventType.LEFT_UP);

// ------------------------------------------------------------------ drawing

function renderGlobe() {
  viewer.entities.removeAll();
  for (const it of items()) {
    const p = itemPos(it);
    const r = it.ref;
    const position = Cesium.Cartesian3.fromDegrees(p.lon_deg, p.lat_deg, it.type === "ship" ? 0 : 200);
    const label = it.type === "strike" ? `${r.callsign} (${r.count}× ${r.class})` : r.name;
    const e = viewer.entities.add({
      position,
      billboard: {
        image: SYMBOLS[`${it.side}-${it.type === "ship" ? "ship" : "aircraft"}`],
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: r === selected ? 1.4 : 1,
      },
      label: {
        text: label, font: "12px sans-serif", fillColor: COLORS[it.side], outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -22),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    e._ref = r;
    if (it.type === "patrol") {
      // orbit circle
      viewer.entities.add({
        position,
        ellipse: {
          semiMajorAxis: 1000 * r.mission.radius_km, semiMinorAxis: 1000 * r.mission.radius_km, height: 100,
          fill: false, outline: true, outlineColor: COLORS[it.side].withAlpha(0.6),
        },
      });
    }
  }
  renderPlaced();
}

function renderPlaced() {
  const list = items();
  $("placedList").innerHTML = list.length
    ? list.map((it, i) => `
      <div class="placed-item ${it.ref === selected ? "sel" : ""}" data-i="${i}">
        <span class="side-${it.side}">${escapeHtml(it.type === "strike" ? it.ref.callsign : it.ref.name)}</span>
        <span class="muted">${it.type === "ship" ? "ship" : it.type === "patrol" ? "patrol" : `strike ×${it.ref.count}`} · ${escapeHtml(it.ref.class)}</span>
      </div>`).join("")
    : '<div class="muted">Pick a unit on the left, then click the map.</div>';
}

$("placedList").addEventListener("click", (ev) => {
  const el = ev.target.closest(".placed-item");
  if (!el) return;
  const it = items()[Number(el.dataset.i)];
  select(it.ref);
  const p = itemPos(it);
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(p.lon_deg, p.lat_deg, 150000), duration: 1 });
});

// ------------------------------------------------------------------ inspector

function select(ref) {
  selected = ref;
  renderInspector();
  renderGlobe();
}

/** Bind an input to a property; `conv` turns the input string into the stored value. */
function bind(id, get, set, conv = (v) => v) {
  const el = $(id);
  if (!el) return;
  if (el.type === "checkbox") el.checked = !!get();
  else el.value = get() ?? "";
  el.addEventListener("change", () => {
    set(el.type === "checkbox" ? el.checked : conv(el.value));
    renderGlobe();
  });
}
const num = (v) => (v === "" ? 0 : Number(v));

function renderInspector() {
  const it = items().find((x) => x.ref === selected);
  if (!it) return renderSettings();
  const r = it.ref;
  const sidePicker = it.type === "strike" ? "" : `
    <label class="field">Side<select id="iSide"><option value="blue">Blue (you)</option><option value="red">Red (computer)</option></select></label>`;
  let body = "";
  if (it.type === "ship") {
    body = `
      <label class="field">Name<input id="iName"></label>${sidePicker}
      <div class="two">
        <label class="field">Course °<input id="iHeading" type="number" min="0" max="359"></label>
        <label class="field">Speed kts<input id="iSpeed" type="number" min="0" max="${data.ships[r.class]?.maxSpeed_kts ?? 40}"></label>
      </div>`;
  } else if (it.type === "patrol") {
    body = `
      <label class="field">Name<input id="iName"></label>${sidePicker}
      <div class="two">
        <label class="field">Altitude m<input id="iAlt" type="number" min="100" max="15000"></label>
        <label class="field">Orbit radius km<input id="iRadius" type="number" min="5" max="200"></label>
      </div>
      <div class="field">The flight starts on station, searches with its radar, and leaves when its fuel runs low.</div>`;
  } else {
    body = `
      <label class="field">Callsign<input id="iName"></label>
      <div class="three">
        <label class="field">Aircraft<input id="iCount" type="number" min="1" max="12"></label>
        <label class="field">Raids<input id="iAvail" type="number" min="1" max="6"></label>
        <label class="field">Altitude m<input id="iAlt" type="number" min="15" max="15000"></label>
      </div>
      <div class="two">
        <label class="field">Launch at % of missile range<input id="iLaunch" type="number" min="20" max="95"></label>
        <label class="field">Not before (min)<input id="iNotBefore" type="number" min="0"></label>
      </div>
      <div class="field">${it.side === "blue"
        ? "You call this strike from a contact's \"Air strike\" button."
        : "The computer sends it at your largest ship once it has a contact on it."} The aircraft take off from this point, which must be within their fuel range of the target.</div>`;
  }
  const db = it.type === "ship" ? data.ships[r.class] : data.aircraft[r.class];
  $("inspector").innerHTML = `
    <h2>${it.type === "ship" ? "Ship" : it.type === "patrol" ? "Patrol flight" : "Strike package"} <span class="side-${it.side}">(${it.side})</span></h2>
    <h3>${escapeHtml(r.class)}</h3>
    ${db?.note ? `<div class="sub">${escapeHtml(db.note)}</div>` : ""}
    <div class="sub">${escapeHtml(db?.country || "")}${db?.year ? ` · setup ${db.year}` : ""} · ${it.type === "patrol"
      ? escapeHtml(db?.sensors.map((s) => s.name).join(", ") || "no radar") : escapeHtml(db ? weaponsSummary(db) : "")}</div>
    ${body}
    <div class="field">Drag it on the map to move it.</div>
    <div class="brief-actions">
      <button id="iDone">Done</button>
      <button id="iDelete" class="danger">Delete</button>
    </div>`;
  if (it.type === "strike") {
    bind("iName", () => r.callsign, (v) => (r.callsign = v));
    bind("iCount", () => r.count, (v) => (r.count = Math.max(1, v)), num);
    bind("iAvail", () => r.available, (v) => (r.available = Math.max(1, v)), num);
    bind("iAlt", () => r.alt_m, (v) => (r.alt_m = v), num);
    bind("iLaunch", () => Math.round(100 * r.launchFraction), (v) => (r.launchFraction = v / 100), num);
    bind("iNotBefore", () => Math.round((r.notBefore_s || 0) / 60), (v) => (r.notBefore_s = 60 * v), num);
  } else {
    bind("iName", () => r.name, (v) => (r.name = v));
    bind("iSide", () => r.side, (v) => (r.side = v));
    bind("iHeading", () => r.heading_deg, (v) => (r.heading_deg = ((v % 360) + 360) % 360), num);
    bind("iSpeed", () => r.speed_kts, (v) => (r.speed_kts = v), num);
    if (it.type === "patrol") {
      bind("iAlt", () => r.mission.alt_m, (v) => (r.alt_m = r.mission.alt_m = v), num);
      bind("iRadius", () => r.mission.radius_km, (v) => (r.mission.radius_km = v), num);
    }
  }
  $("iDone").onclick = () => select(null);
  $("iDelete").onclick = () => {
    removeItem(it);
    select(null);
  };
}

/** Scenario-wide options, shown when nothing is selected. */
function renderSettings() {
  const intel = (s) => scenario.intel?.[s];
  $("inspector").innerHTML = `
    <h2>Scenario settings</h2>
    <label class="field">Briefing<textarea id="sDesc" placeholder="What's the situation? What should the player do?"></textarea></label>
    <div class="two">
      <label class="field">Time limit (min, 0 = none)<input id="sEnd" type="number" min="0"></label>
      <label class="field">Random seed<input id="sSeed" type="number"></label>
    </div>
    <hr>
    <h2>Patrol-aircraft reports</h2>
    <div class="field">Simulated reports of all enemy ships at intervals, with a position error. Use them when a side has no patrol aircraft of its own.</div>
    ${["blue", "red"].map((s) => `
      <label class="field inline"><input id="sIntel_${s}" type="checkbox"> <span class="side-${s}">${s}</span> receives reports</label>
      <div class="two">
        <label class="field">Every (min)<input id="sIntelEvery_${s}" type="number" min="1"></label>
        <label class="field">Error (km)<input id="sIntelErr_${s}" type="number" min="0" step="0.5"></label>
      </div>`).join("")}
    <hr>
    <h2>Computer opponent (red)</h2>
    <label class="field inline"><input id="sRedFree" type="checkbox"> Attacks your ships when in range</label>
    <label class="field">Missiles per ship in a salvo<input id="sRedSalvo" type="number" min="1" max="16"></label>
    <label class="field inline"><input id="sRedDefend" type="checkbox"> Red defends itself (SAMs)</label>
    <label class="field inline"><input id="sBlueDefend" type="checkbox"> Your ships defend themselves automatically</label>
    <hr>
    <div class="field">Fly the globe to where the action should start, then
      <button id="sCamera">Use current view as start view</button></div>`;
  bind("sDesc", () => scenario.description, (v) => (scenario.description = v));
  bind("sEnd", () => Math.round((scenario.endAt_s || 0) / 60), (v) => (scenario.endAt_s = 60 * v || undefined), num);
  bind("sSeed", () => scenario.seed, (v) => (scenario.seed = v), num);
  for (const s of ["blue", "red"]) {
    const ensure = () => (scenario.intel[s] ||= { source: `${s === "blue" ? "Blue" : "Red"} patrol report`, interval_s: 600, error_m: 3000, firstAt_s: 60 });
    bind(`sIntel_${s}`, () => intel(s), (on) => {
      if (on) ensure();
      else delete scenario.intel[s];
    });
    bind(`sIntelEvery_${s}`, () => Math.round((intel(s)?.interval_s ?? 600) / 60), (v) => (ensure().interval_s = 60 * Math.max(1, v)), num);
    bind(`sIntelErr_${s}`, () => (intel(s)?.error_m ?? 3000) / 1000, (v) => (ensure().error_m = 1000 * v), num);
  }
  bind("sRedFree", () => scenario.ai.red.weaponsFree, (v) => (scenario.ai.red.weaponsFree = v));
  bind("sRedSalvo", () => scenario.ai.red.salvo ?? 4, (v) => (scenario.ai.red.salvo = Math.max(1, v)), num);
  bind("sRedDefend", () => scenario.ai.red.autoDefend !== false, (v) => (scenario.ai.red.autoDefend = v));
  bind("sBlueDefend", () => scenario.ai.blue.autoDefend !== false, (v) => (scenario.ai.blue.autoDefend = v));
  $("sCamera").onclick = () => {
    captureCamera();
    $("sCamera").textContent = "Start view saved";
  };
}

function captureCamera() {
  const c = viewer.camera.positionCartographic;
  scenario.camera = {
    lat_deg: +(c.latitude / DEG).toFixed(3), lon_deg: +(c.longitude / DEG).toFixed(3),
    alt_m: Math.round(c.height), pitch_deg: Math.round(viewer.camera.pitch / DEG),
  };
}

// ------------------------------------------------------------------ open, save, play

function problems() {
  const out = [];
  if (!scenario.units.some((u) => u.side === "blue")) out.push("Add at least one blue ship for you to command.");
  if (!scenario.units.some((u) => u.side === "red") && !scenario.strikes.red.length) {
    out.push("Give red something to fight with: a ship or a strike package.");
  }
  for (const s of ["blue", "red"]) {
    const enemyShips = scenario.units.some((u) => u.side !== s);
    const canSee = scenario.intel[s] || scenario.air.some((a) => a.side === s) || scenario.units.some((u) => u.side === s);
    if (scenario.strikes[s].length && !enemyShips) out.push(`${s} has a strike package but there are no enemy ships to strike.`);
    if (!canSee) out.push(`${s} has no way to find the enemy: add ships, a patrol flight, or patrol reports.`);
  }
  return out;
}

function exportScenario() {
  scenario.name = $("scName").value.trim() || "Untitled scenario";
  if (!scenario.endAt_s) delete scenario.endAt_s;
  return JSON.parse(JSON.stringify(scenario));
}

function save() {
  const s = exportScenario();
  localId ||= `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scenario"}-${Date.now().toString(36)}`;
  if (!saveLocalScenario(localId, s)) {
    alert("This browser won't let the page save. Use Download to keep a copy as a file.");
    return null;
  }
  history.replaceState(null, "", `?scenario=local:${encodeURIComponent(localId)}`);
  refreshOpenList();
  return localId;
}

$("saveBtn").onclick = () => {
  if (save()) flash($("saveBtn"), "Saved");
};
$("playBtn").onclick = () => {
  const p = problems();
  if (p.length && !confirm(`This scenario may not play well:\n\n• ${p.join("\n• ")}\n\nPlay anyway?`)) return;
  const id = save();
  if (id) location.href = `index.html?scenario=local:${encodeURIComponent(id)}`;
};
$("downloadBtn").onclick = () => {
  const s = exportScenario();
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "scenario"}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$("loadBtn").onclick = () => $("loadFile").click();
$("loadFile").onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!Array.isArray(s.units)) throw new Error("not a scenario file (no units list)");
    open(normalize(s), null);
  } catch (e) {
    alert(`Couldn't load that file: ${e.message}`);
  }
};
$("newBtn").onclick = () => {
  if (items().length && !confirm("Start a new, empty scenario? Unsaved changes are lost.")) return;
  open(blankScenario(), null);
  history.replaceState(null, "", "editor.html");
};
$("openPick").onchange = (ev) => {
  if (ev.target.value) location.search = `?scenario=${encodeURIComponent(ev.target.value)}`;
};

function open(s, id) {
  scenario = s;
  localId = id;
  selected = null;
  $("scName").value = scenario.name;
  const c = scenario.camera || {};
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(c.lon_deg ?? 0, c.lat_deg ?? 0, c.alt_m ?? 3000000),
    orientation: { heading: 0, pitch: (c.pitch_deg ?? -70) * DEG, roll: 0 },
  });
  renderInspector();
  renderGlobe();
}

async function refreshOpenList() {
  const list = await listScenarios();
  $("openPick").innerHTML = '<option value="">Open…</option>' + list.map((s) => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.name)}</option>`).join("");
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
const escapeAttr = escapeHtml;

// built-in scenarios open as a copy: saving creates a new scenario in this browser
$("scName").value = scenario.name + (startId && !startId.startsWith("local:") ? " (copy)" : "");
refreshOpenList();
renderCatalogue();
renderInspector();
renderGlobe();
