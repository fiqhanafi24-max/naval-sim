// Model gallery: browse the procedural 3D model of every ship, aircraft and missile in the catalogue.
/* global Cesium */

import { createViewer } from "./common.js";
import { buildAircraftGltf, buildMissileGltf, buildShipGltf } from "./models.js";

const $ = (id) => document.getElementById(id);
const data = await fetch("data/gcb-units.json").then((r) => r.json());
const viewer = createViewer("globe", { lat_deg: 20, lon_deg: -30, alt_m: 2000 });
viewer.clock.shouldAnimate = true;

const SPOT = { lat_deg: 20, lon_deg: -30 };
let kind = "ships";
let selected = null;
let entity = null;
let heading = 0.6;

/** Size used to frame the camera, and the info rows for the panel. */
function describe(k, d) {
  if (k === "ships") {
    return { size: d.length_m, alt: 0, rows: [["Type", d.shipType], ["Country", d.country], ["Length", `${d.length_m} m`], ["Beam", `${d.beam_m} m`], ["Max speed", `${d.maxSpeed_kts} kts`]] };
  }
  if (k === "aircraft") {
    const L = { jet: 5.6, heavy: 7, prop: 7.5, helo: 9 }[d.airframe] * Math.cbrt(Math.max(d.mtow_kg || 15000, 1000) / 1000);
    return { size: L, alt: 300, rows: [["Airframe", d.airframe], ["Role", d.role], ["Max take-off", `${(d.mtow_kg / 1000).toFixed(1)} t`], ["Model length", `${L.toFixed(1)} m`]] };
  }
  const L = 0.52 * Math.cbrt(Math.max(d.weight_kg || 500, 10));
  return { size: L, alt: 100, rows: [["Weight", `${d.weight_kg} kg`], ["Max range", `${d.maxRange_km} km`], ["Seeker", d.seekerType || "—"], ["Model length", `${L.toFixed(1)} m`]] };
}

function build(k, d) {
  if (k === "ships") return buildShipGltf(d, d.country === "USA" ? "us" : "soviet");
  if (k === "aircraft") return buildAircraftGltf(d);
  return buildMissileGltf(d);
}

function show(name) {
  selected = name;
  const d = data[kind][name];
  const { size, alt, rows } = describe(kind, d);
  if (entity) viewer.entities.remove(entity);
  const position = Cesium.Cartesian3.fromDegrees(SPOT.lon_deg, SPOT.lat_deg, alt);
  entity = viewer.entities.add({
    position,
    model: { uri: build(kind, d), shadows: Cesium.ShadowMode.DISABLED },
    orientation: new Cesium.CallbackProperty(() => Cesium.Transforms.headingPitchRollQuaternion(position, new Cesium.HeadingPitchRoll(heading - Math.PI / 2, 0, 0)), false),
  });
  viewer.camera.lookAt(position, new Cesium.HeadingPitchRange(0, -0.35, 2.2 * size + 10));
  $("info").innerHTML = `<h2>${name}</h2><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b ?? "—"}</dd>`).join("")}</dl>`;
  for (const el of document.querySelectorAll(".cat-item")) el.classList.toggle("sel", el.dataset.name === name);
}

function list() {
  const q = $("q").value.trim().toLowerCase();
  const names = Object.keys(data[kind]).filter((n) => !q || n.toLowerCase().includes(q) || (data[kind][n].country || "").toLowerCase().includes(q)).sort();
  $("results").innerHTML = names.map((n) => {
    const d = data[kind][n];
    const meta = kind === "ships" ? `${d.shipType} · ${d.country} · ${d.length_m} m` : kind === "aircraft" ? `${d.airframe} · ${d.role}` : `${d.weight_kg} kg`;
    return `<div class="cat-item" data-name="${n.replace(/"/g, "&quot;")}"><div class="n">${n}</div><div class="m">${meta}</div></div>`;
  }).join("");
  if (!names.includes(selected) && names.length) show(names[0]);
  else if (selected) show(selected);
}

$("results").addEventListener("click", (ev) => {
  const item = ev.target.closest(".cat-item");
  if (item) show(item.dataset.name);
});
$("q").addEventListener("input", list);
for (const b of document.querySelectorAll("#kind button")) {
  b.addEventListener("click", () => {
    kind = b.dataset.k;
    selected = null;
    for (const o of document.querySelectorAll("#kind button")) o.classList.toggle("on", o === b);
    list();
  });
}
viewer.clock.onTick.addEventListener(() => {
  if ($("spin").checked) heading += 0.004;
});
list();
