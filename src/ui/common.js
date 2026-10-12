// Shared by the game (app.js) and the scenario editor (editor.js): globe setup, colours,
// unit symbols, and loading scenarios saved in the browser.
/* global Cesium */

import { DEG } from "../sim/geo.js";

export const PLAYER = "blue";
const LOCAL_KEY = "naval-sim.scenarios";

/** Cesium viewer with offline Natural Earth imagery and no Ion services. */
export function createViewer(containerId, camera = {}) {
  const viewer = new Cesium.Viewer(containerId, {
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
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(camera.lon_deg ?? 0, camera.lat_deg ?? 0, camera.alt_m ?? 200000),
    orientation: { heading: 0, pitch: (camera.pitch_deg ?? -60) * DEG, roll: 0 },
  });
  return viewer;
}

export const COLORS = {
  blue: Cesium.Color.fromCssColorString("#4da3ff"),
  red: Cesium.Color.fromCssColorString("#ff5a52"),
  amber: Cesium.Color.fromCssColorString("#ffb547"),
  white: Cesium.Color.WHITE,
};

/**
 * NTDS-style symbols drawn on canvas. Friendly: circle (ship), square (missile), upper
 * semicircle (aircraft). Hostile: diamond (ship, missile), upper chevron (aircraft).
 */
function symbol(side, kind) {
  const c = document.createElement("canvas");
  const s = kind === "ship" ? 28 : kind === "aircraft" ? 22 : 16;
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.lineWidth = kind === "missile" ? 2 : 2.5;
  g.strokeStyle = side === PLAYER ? "#4da3ff" : "#ff5a52";
  g.fillStyle = side === PLAYER ? "rgba(77,163,255,0.25)" : "rgba(255,90,82,0.25)";
  g.beginPath();
  const m = s / 2;
  const r = s / 2 - 3;
  if (kind === "aircraft") {
    if (side === PLAYER) g.arc(m, m + r / 2, r, Math.PI, 0);
    else { g.moveTo(m - r, m + r / 2); g.lineTo(m, m - r / 2); g.lineTo(m + r, m + r / 2); }
    g.stroke();
    return c;
  }
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
export const SYMBOLS = {};
for (const side of ["blue", "red"]) for (const kind of ["ship", "missile", "aircraft"]) SYMBOLS[`${side}-${kind}`] = symbol(side, kind);

// ------------------------------------------------------------------ scenarios saved in this browser

/** {id: scenario} saved by the editor. Browser storage can be unavailable; then this is empty. */
export function loadLocalScenarios() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveLocalScenario(id, scenario) {
  const all = loadLocalScenarios();
  all[id] = scenario;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function deleteLocalScenario(id) {
  const all = loadLocalScenarios();
  delete all[id];
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable: nothing to delete
  }
}

/** Load a scenario by id: built-in ids from scenarios/, "local:<id>" from this browser. */
export async function loadScenario(id) {
  if (id.startsWith("local:")) {
    const s = loadLocalScenarios()[id.slice(6)];
    if (!s) throw new Error(`Saved scenario not found in this browser: ${id.slice(6)}`);
    return s;
  }
  const r = await fetch(`scenarios/${id}.json`);
  if (!r.ok) throw new Error(`Scenario not found: ${id}`);
  return r.json();
}

/** Built-in scenarios plus those saved in this browser, for pickers. */
export async function listScenarios() {
  let builtIn = [];
  try {
    builtIn = await fetch("scenarios/index.json").then((r) => r.json());
  } catch {
    // index missing: built-in list stays empty
  }
  const local = Object.entries(loadLocalScenarios()).map(([id, s]) => ({ id: `local:${id}`, name: `${s.name} (my scenario)` }));
  return [...builtIn, ...local];
}
