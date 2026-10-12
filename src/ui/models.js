// Procedural low-poly ship, aircraft and missile models, built as glTF in memory so the
// project needs no third-party model files. They are generic shapes per type (carrier,
// combatant, small craft, auxiliary; jet, heavy jet, turboprop, helicopter; missile), sized
// from the GCB2 database: ship length/beam/height, aircraft max take-off weight, missile weight.
//
// glTF is Y-up; Cesium converts it to Z-up. Models are built with +X toward the bow/nose,
// +Y up and +Z to port, so they orient like the hull boxes (heading - 90°).

const HAZE_GREY = [0.55, 0.58, 0.6, 1];
const SOVIET_GREY = [0.45, 0.5, 0.53, 1];
const DECK = [0.33, 0.35, 0.36, 1];
const HULL_RED = [0.42, 0.16, 0.14, 1];
const AIR_GREY = [0.62, 0.65, 0.68, 1];
const DARK = [0.18, 0.19, 0.2, 1];
const CANOPY = [0.12, 0.16, 0.22, 1];
const ROTOR = [0.12, 0.12, 0.12, 0.35]; // spinning rotor / propeller disc, translucent
const MISSILE_WHITE = [0.86, 0.87, 0.85, 1];

/** Append a flat-shaded triangle fan / quad list to a mesh builder. */
class MeshBuilder {
  constructor() {
    this.parts = new Map(); // material index -> {pos: [], nrm: []}
  }

  tri(mat, a, b, c) {
    const p = this.parts.get(mat) || this.parts.set(mat, { pos: [], nrm: [] }).get(mat);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len);
    for (const q of [a, b, c]) {
      p.pos.push(...q);
      p.nrm.push(...n);
    }
  }

  quad(mat, a, b, c, d) {
    this.tri(mat, a, b, c);
    this.tri(mat, a, c, d);
  }

  /** Axis-aligned box from (x0,y0,z0) to (x1,y1,z1). */
  box(mat, x0, y0, z0, x1, y1, z1) {
    const p = (x, y, z) => [x, y, z];
    this.quad(mat, p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)); // top
    this.quad(mat, p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)); // +z
    this.quad(mat, p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)); // -z
    this.quad(mat, p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)); // +x
    this.quad(mat, p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)); // -x
  }

  /** Flat polygon, fanned from its first point (convex) or from `centre` (star-shaped). */
  poly(mat, pts, centre) {
    if (centre) {
      for (let i = 0; i < pts.length; i++) this.tri(mat, centre, pts[i], pts[(i + 1) % pts.length]);
    } else {
      for (let i = 1; i < pts.length - 1; i++) this.tri(mat, pts[0], pts[i], pts[i + 1]);
    }
  }

  /** Body of revolution along X: stations [{x, r, y?, z?}] joined by n-sided rings, ends capped. */
  tube(mat, stations, n = 8) {
    const ring = (st) => Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n;
      return [st.x, (st.y || 0) + st.r * Math.cos(a), (st.z || 0) + st.r * Math.sin(a)];
    });
    const rings = stations.map(ring);
    for (let i = 0; i < rings.length - 1; i++) {
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        this.quad(mat, rings[i][k], rings[i + 1][k], rings[i + 1][k1], rings[i][k1]);
      }
    }
    for (const i of [0, rings.length - 1]) if (stations[i].r > 0) this.poly(mat, rings[i]);
  }

  /** Vertical cylinder (rotodome, rotor mast). */
  cylinderY(mat, cx, cz, y0, y1, r, n = 12) {
    const at = (y) => Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n;
      return [cx + r * Math.cos(a), y, cz + r * Math.sin(a)];
    });
    const lo = at(y0), hi = at(y1);
    for (let k = 0; k < n; k++) this.quad(mat, lo[k], lo[(k + 1) % n], hi[(k + 1) % n], hi[k]);
    this.poly(mat, lo);
    this.poly(mat, hi);
  }

  /** Disc of radius r centred at c, in the plane normal to `axis` ("x", "y" or "z"). */
  disc(mat, c, r, axis, n = 16) {
    const pts = Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n;
      const u = r * Math.cos(a), v = r * Math.sin(a);
      if (axis === "x") return [c[0], c[1] + u, c[2] + v];
      if (axis === "y") return [c[0] + u, c[1], c[2] + v];
      return [c[0] + u, c[1] + v, c[2]];
    });
    this.poly(mat, pts);
  }

  /**
   * Pair of mirrored flat surfaces (wings, tailplanes): root chord from rootFront to rootBack
   * at z = ±zRoot, tip chord from tipFront to tipBack at z = ±(zRoot + span), at height y.
   */
  wings(mat, { rootFront, rootBack, tipFront, tipBack, span, y = 0, zRoot = 0, dihedral = 0 }) {
    for (const s of [1, -1]) {
      const yt = y + dihedral * span;
      this.poly(mat, [[rootFront, y, s * zRoot], [tipFront, yt, s * (zRoot + span)], [tipBack, yt, s * (zRoot + span)], [rootBack, y, s * zRoot]]);
    }
  }

  /** Vertical fin in the centre plane: root from xFront to xBack at y0, tip at y1 swept by `sweep`. */
  fin(mat, xFront, xBack, y0, y1, sweep, z = 0) {
    this.poly(mat, [[xFront, y0, z], [xBack, y0, z], [xBack - sweep * 0.3, y1, z], [xFront - sweep, y1, z]]);
  }
}

/**
 * Hull outline at deck level: pointed bow, parallel midbody, squared transom.
 * @returns array of [x, z] going round the outline counter-clockwise seen from above
 */
function hullOutline(L, B, n = 6) {
  const pts = [];
  const bowStart = 0.25 * L; // where the hull starts narrowing
  for (let i = 0; i <= n; i++) {
    const x = bowStart + (i / n) * (0.5 * L - bowStart);
    const w = 0.5 * B * Math.sqrt(1 - Math.pow((x - bowStart) / (0.5 * L - bowStart), 2) * 0.98);
    pts.push([x, w]);
  }
  pts.push([-0.5 * L, 0.42 * B]);
  const port = pts.map(([x, z]) => [x, z]);
  const stbd = pts.slice().reverse().map(([x, z]) => [x, -z]);
  return [...port, ...stbd];
}

/**
 * Build a ship mesh.
 * @param {{name, length_m, beam_m, effectiveHeight_m, shipType}} dims GCB2 ship record;
 *   shipType is carrier | flattop | auxiliary | small | combatant
 * @param {"us"|"soviet"} style colour scheme
 */
export function buildShipGltf(dims, style = "us") {
  const L = dims.length_m || 150;
  const B = Math.max(dims.beam_m || 16, 6);
  const H = Math.max(dims.effectiveHeight_m || 10, 4); // GCB2 effective height is roughly the hull+superstructure centroid
  const freeboard = 0.45 * H;
  const draft = 0.25 * H;
  const m = new MeshBuilder();
  const GREY = 0, DK = 1, RED = 2;

  // hull: deck outline at freeboard, slightly narrower waterline below, sides joined
  const deck = hullOutline(L, B);
  const water = hullOutline(L * 0.97, B * 0.9);
  for (let i = 0; i < deck.length; i++) {
    const j = (i + 1) % deck.length;
    const [dx0, dz0] = deck[i];
    const [dx1, dz1] = deck[j];
    const [wx0, wz0] = water[i];
    const [wx1, wz1] = water[j];
    m.quad(GREY, [wx0, 0, wz0], [wx1, 0, wz1], [dx1, freeboard, dz1], [dx0, freeboard, dz0]);
    m.quad(RED, [wx0, -draft, wz0 * 0.8], [wx1, -draft, wz1 * 0.8], [wx1, 0, wz1], [wx0, 0, wz0]);
  }
  // deck as a fan from the centre
  for (let i = 0; i < deck.length; i++) {
    const j = (i + 1) % deck.length;
    m.tri(DK, [0, freeboard, 0], [deck[j][0], freeboard, deck[j][1]], [deck[i][0], freeboard, deck[i][1]]);
  }

  const y0 = freeboard;
  const ss = 0.32 * B;
  const topside = { carrier: carrierTopside, flattop: carrierTopside, auxiliary: auxiliaryTopside, small: smallCraftTopside }[dims.shipType];
  if (topside) {
    topside(m, { L, B, H, y0, ss, flattop: dims.shipType === "flattop", amphib: /LPD|LSD|LST/.test(dims.name || "") });
    return toGltfDataUri(m, [style === "soviet" ? SOVIET_GREY : HAZE_GREY, DECK, HULL_RED]);
  }

  // combatant superstructure: forward block with bridge, aft hangar block, funnel(s), mast
  m.box(GREY, 0.02 * L, y0, -ss, 0.2 * L, y0 + 0.9 * H, ss); // forward superstructure
  m.box(GREY, 0.12 * L, y0 + 0.9 * H, -0.8 * ss, 0.19 * L, y0 + 1.25 * H, 0.8 * ss); // bridge
  m.box(GREY, -0.3 * L, y0, -ss, -0.05 * L, y0 + 0.65 * H, ss); // aft block / hangar
  if (style === "soviet") {
    m.box(DK, -0.04 * L, y0, -0.18 * B, 0.02 * L, y0 + 1.2 * H, 0.18 * B); // single large funnel
  } else {
    m.box(DK, -0.02 * L, y0, -0.12 * B, 0.02 * L, y0 + 1.0 * H, 0.12 * B); // two slim stacks
    m.box(DK, -0.1 * L, y0, -0.12 * B, -0.06 * L, y0 + 0.95 * H, 0.12 * B);
  }
  m.box(DK, 0.07 * L, y0 + 0.9 * H, -0.02 * B, 0.09 * L, y0 + 2.4 * H, 0.02 * B); // mast
  m.box(DK, 0.04 * L, y0 + 2.0 * H, -0.15 * B, 0.12 * L, y0 + 2.08 * H, 0.15 * B); // yard / radar
  m.box(DK, 0.32 * L, y0, -0.06 * B, 0.36 * L, y0 + 0.3 * H, 0.06 * B); // forward gun mount

  const colours = [style === "soviet" ? SOVIET_GREY : HAZE_GREY, DECK, HULL_RED];
  return toGltfDataUri(m, colours);
}

const GREY = 0, DK = 1;

/** Aircraft carrier (angled deck) or amphibious flattop: flight deck overhanging the hull, island to starboard. */
function carrierTopside(m, { L, B, H, y0, flattop }) {
  const W = flattop ? Math.min(1.15 * B, 0.18 * L) : Math.min(1.8 * B, 0.25 * L); // flight deck width
  const yd = y0 + 0.35 * H; // flight deck height
  const stbd = -0.42 * W;
  const outline = flattop
    ? [[0.5 * L, 0.2 * W], [0.42 * L, 0.5 * W], [-0.5 * L, 0.5 * W], [-0.5 * L, -0.5 * W], [0.42 * L, -0.5 * W], [0.5 * L, -0.2 * W]]
    : [[0.5 * L, 0.18 * W], [0.4 * L, 0.3 * W], [0.05 * L, 0.3 * W], [-0.3 * L, 0.55 * W], [-0.5 * L, 0.45 * W],
       [-0.5 * L, stbd], [0.35 * L, stbd], [0.5 * L, -0.18 * W]];
  const top = outline.map(([x, z]) => [x, yd, z]);
  m.poly(DK, top, [0, yd, 0]);
  // deck edge and the hangar/sponson structure under it
  for (let i = 0; i < outline.length; i++) {
    const [x0, z0] = outline[i];
    const [x1, z1] = outline[(i + 1) % outline.length];
    m.quad(GREY, [x0, yd - 0.12 * H, z0], [x1, yd - 0.12 * H, z1], [x1, yd, z1], [x0, yd, z0]);
  }
  m.box(GREY, -0.42 * L, y0, -0.45 * B, 0.38 * L, yd - 0.05, 0.45 * B); // hangar deck
  // island with mast and radar
  const ix = -0.05 * L;
  m.box(GREY, ix, yd, stbd - 0.06 * W, ix + 0.12 * L, yd + 0.9 * H, stbd + 0.08 * W);
  m.box(GREY, ix + 0.07 * L, yd + 0.9 * H, stbd - 0.04 * W, ix + 0.12 * L, yd + 1.15 * H, stbd + 0.06 * W);
  m.box(DK, ix + 0.04 * L, yd + 0.9 * H, stbd - 0.004 * L, ix + 0.05 * L, yd + 1.7 * H, stbd + 0.004 * L);
  m.box(DK, ix + 0.02 * L, yd + 1.45 * H, stbd - 0.05 * W, ix + 0.07 * L, yd + 1.5 * H, stbd + 0.05 * W);
}

/** Replenishment ships, transports and amphibious ships: bridge aft, kingposts and cranes forward. */
function auxiliaryTopside(m, { L, B, H, y0, ss, amphib }) {
  if (amphib) {
    // dock ships: forward superstructure block, flight deck/well deck aft
    m.box(GREY, -0.05 * L, y0, -0.9 * ss * 1.4, 0.3 * L, y0 + 1.0 * H, 0.9 * ss * 1.4);
    m.box(GREY, 0.2 * L, y0 + 1.0 * H, -ss, 0.28 * L, y0 + 1.25 * H, ss);
    m.box(DK, 0.08 * L, y0 + 1.0 * H, -0.12 * B, 0.13 * L, y0 + 1.35 * H, 0.12 * B);
    m.box(DK, 0.22 * L, y0 + 1.25 * H, -0.02 * B, 0.235 * L, y0 + 2.1 * H, 0.02 * B);
    return;
  }
  m.box(GREY, -0.47 * L, y0, -ss * 1.3, -0.3 * L, y0 + 1.1 * H, ss * 1.3); // accommodation and bridge aft
  m.box(GREY, -0.36 * L, y0 + 1.1 * H, -ss, -0.31 * L, y0 + 1.3 * H, ss);
  m.box(DK, -0.44 * L, y0 + 1.1 * H, -0.1 * B, -0.4 * L, y0 + 1.45 * H, 0.1 * B); // funnel
  m.box(GREY, 0.36 * L, y0, -ss * 0.6, 0.44 * L, y0 + 0.45 * H, ss * 0.6); // forecastle block
  for (const x of [0.25, 0.08, -0.09]) {
    m.box(DK, x * L - 0.01 * L, y0, -0.03 * B, x * L + 0.01 * L, y0 + 1.1 * H, 0.03 * B); // kingpost
    m.box(DK, x * L - 0.008 * L, y0 + 0.9 * H, -0.42 * B, x * L + 0.008 * L, y0 + 0.95 * H, 0.42 * B); // rig crossbar
  }
}

/** Patrol boats, fast attack craft, corvettes under 60 m: low bridge, mast, gun forward, missiles aft. */
function smallCraftTopside(m, { L, B, H, y0, ss }) {
  m.box(GREY, -0.12 * L, y0, -ss * 1.1, 0.16 * L, y0 + 0.7 * H, ss * 1.1); // deckhouse and bridge
  m.box(GREY, 0.04 * L, y0 + 0.7 * H, -ss * 0.8, 0.14 * L, y0 + 0.95 * H, ss * 0.8);
  m.box(DK, 0.0, y0 + 0.7 * H, -0.03 * B, 0.03 * L, y0 + 2.0 * H, 0.03 * B); // mast
  m.box(DK, -0.03 * L, y0 + 1.7 * H, -0.18 * B, 0.06 * L, y0 + 1.76 * H, 0.18 * B); // radar
  m.box(DK, 0.27 * L, y0, -0.08 * B, 0.33 * L, y0 + 0.35 * H, 0.08 * B); // gun
  for (const z of [0.22, -0.22]) m.box(GREY, -0.42 * L, y0 + 0.05 * H, z * B - 0.07 * B, -0.2 * L, y0 + 0.35 * H, z * B + 0.07 * B); // missile canisters
}

const AEW = /^(E-2|AEW|E-3|A-50|WF-2|Gannet AEW)/;

/**
 * Build an aircraft mesh from a GCB2 aircraft record.
 * @param {{name, airframe, mtow_kg}} db airframe is jet | heavy | prop | helo
 */
export function buildAircraftGltf(db) {
  const t = Math.max(db.mtow_kg || 15000, 1000) / 1000;
  const type = db.airframe || "jet";
  const L = { jet: 5.6, heavy: 7, prop: 7.5, helo: 9 }[type] * Math.cbrt(t); // length from weight
  const m = new MeshBuilder();
  const BODY = 0, DKM = 1, GLASS = 2, DISC = 3;
  if (type === "helo") {
    m.tube(BODY, [
      { x: 0.42 * L, r: 0, y: 0.01 * L }, { x: 0.36 * L, r: 0.06 * L }, { x: 0.2 * L, r: 0.085 * L }, { x: -0.05 * L, r: 0.085 * L },
      { x: -0.14 * L, r: 0.035 * L, y: 0.03 * L }, { x: -0.44 * L, r: 0.018 * L, y: 0.04 * L }, { x: -0.48 * L, r: 0, y: 0.05 * L },
    ]);
    m.tube(GLASS, [{ x: 0.4 * L, r: 0, y: 0.03 * L }, { x: 0.33 * L, r: 0.05 * L, y: 0.03 * L }, { x: 0.24 * L, r: 0, y: 0.05 * L }]);
    m.fin(BODY, -0.4 * L, -0.48 * L, 0.04 * L, 0.15 * L, 0.03 * L);
    m.wings(BODY, { rootFront: -0.36 * L, rootBack: -0.41 * L, tipFront: -0.37 * L, tipBack: -0.41 * L, span: 0.06 * L, y: 0.04 * L });
    m.cylinderY(DKM, 0.08 * L, 0, 0.08 * L, 0.13 * L, 0.02 * L, 8); // rotor mast
    m.disc(DISC, [0.08 * L, 0.13 * L, 0], 0.46 * L, "y", 24); // main rotor
    m.disc(DISC, [-0.46 * L, 0.08 * L, 0.025 * L], 0.08 * L, "z", 12); // tail rotor
    return toGltfDataUri(m, [AIR_GREY, DARK, CANOPY, ROTOR]);
  }
  const R = { jet: 0.05, heavy: 0.045, prop: 0.05 }[type] * L; // fuselage radius
  m.tube(BODY, [
    { x: 0.5 * L, r: 0 }, { x: 0.42 * L, r: 0.6 * R }, { x: 0.3 * L, r: R }, { x: -0.3 * L, r: R },
    { x: -0.46 * L, r: 0.6 * R, y: 0.3 * R }, { x: -0.5 * L, r: 0.3 * R, y: 0.5 * R },
  ]);
  if (type === "jet") {
    m.tube(GLASS, [{ x: 0.36 * L, r: 0, y: 0.8 * R }, { x: 0.28 * L, r: 0.45 * R, y: 0.9 * R }, { x: 0.16 * L, r: 0, y: 1.0 * R }]);
    m.wings(BODY, { rootFront: 0.14 * L, rootBack: -0.22 * L, tipFront: -0.18 * L, tipBack: -0.3 * L, span: 0.36 * L, zRoot: 0.6 * R });
    m.wings(BODY, { rootFront: -0.33 * L, rootBack: -0.48 * L, tipFront: -0.43 * L, tipBack: -0.5 * L, span: 0.15 * L, zRoot: 0.6 * R });
    m.fin(BODY, -0.3 * L, -0.48 * L, R, R + 0.17 * L, 0.12 * L);
    return toGltfDataUri(m, [AIR_GREY, DARK, CANOPY, ROTOR]);
  }
  const swept = type === "heavy";
  const wing = swept
    ? { rootFront: 0.16 * L, rootBack: -0.12 * L, tipFront: -0.18 * L, tipBack: -0.27 * L, span: 0.48 * L, zRoot: 0.8 * R, dihedral: 0.04 }
    : { rootFront: 0.1 * L, rootBack: -0.06 * L, tipFront: 0.06 * L, tipBack: -0.02 * L, span: 0.5 * L, zRoot: 0.8 * R, y: 0.5 * R, dihedral: 0.03 };
  m.wings(BODY, wing);
  m.wings(BODY, { rootFront: -0.36 * L, rootBack: -0.48 * L, tipFront: -0.44 * L, tipBack: -0.5 * L, span: 0.17 * L, zRoot: 0.5 * R, y: 0.3 * R });
  m.fin(BODY, -0.32 * L, -0.5 * L, R, R + 0.16 * L, 0.1 * L);
  m.box(GLASS, 0.36 * L, 0.55 * R, -0.5 * R, 0.42 * L, 0.85 * R, 0.5 * R); // cockpit windows
  // engines along the wing: four on big aircraft, two on smaller ones
  const zs = t > 40 ? [0.16, 0.32] : [0.18];
  for (const f of zs) {
    for (const s of [1, -1]) {
      const z = s * f * L;
      const k = (f * L) / wing.span;
      const le = wing.rootFront + (wing.tipFront - wing.rootFront) * k; // leading edge at this station
      const y = (wing.y || 0) + (wing.dihedral || 0) * f * L - (swept ? 0.6 * R : 0);
      const rn = (swept ? 0.45 : 0.5) * R;
      m.tube(DKM, [{ x: le + 0.06 * L, r: 0.6 * rn, y, z }, { x: le + 0.04 * L, r: rn, y, z }, { x: le - 0.08 * L, r: 0.7 * rn, y, z }], 8);
      if (!swept) m.disc(DISC, [le + 0.065 * L, y, z], 0.07 * L, "x", 16); // propeller
    }
  }
  if (AEW.test(db.name || "")) m.cylinderY(DKM, -0.15 * L, 0, R + 0.06 * L, R + 0.085 * L, 0.12 * L, 16); // rotodome
  return toGltfDataUri(m, [AIR_GREY, DARK, CANOPY, ROTOR]);
}

/** Build a missile mesh: ogive nose, cylindrical body, cruciform tail fins. Length from weight. */
export function buildMissileGltf(db) {
  const L = 0.52 * Math.cbrt(Math.max(db.weight_kg || 500, 10));
  const r = L / 28;
  const m = new MeshBuilder();
  m.tube(0, [{ x: 0.5 * L, r: 0 }, { x: 0.44 * L, r: 0.6 * r }, { x: 0.36 * L, r }, { x: -0.5 * L, r }], 8);
  m.wings(0, { rootFront: -0.34 * L, rootBack: -0.5 * L, tipFront: -0.44 * L, tipBack: -0.5 * L, span: 2.2 * r, zRoot: r });
  for (const s of [1, -1]) m.poly(0, [[-0.34 * L, s * r, 0], [-0.44 * L, s * 3.2 * r, 0], [-0.5 * L, s * 3.2 * r, 0], [-0.5 * L, s * r, 0]]);
  return toGltfDataUri(m, [MISSILE_WHITE]);
}

/** Pack the mesh builder into a single-buffer glTF 2.0 and return it as a data: URI. */
function toGltfDataUri(m, colours) {
  const mats = [...m.parts.keys()];
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const primitives = [];
  let offset = 0;
  for (const mat of mats) {
    const { pos, nrm } = m.parts.get(mat);
    for (const [arr, isPos] of [[pos, true], [nrm, false]]) {
      const f = new Float32Array(arr);
      chunks.push(f);
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: f.byteLength, target: 34962 });
      const acc = { bufferView: bufferViews.length - 1, componentType: 5126, count: arr.length / 3, type: "VEC3" };
      if (isPos) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < arr.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], arr[i + k]);
            max[k] = Math.max(max[k], arr[i + k]);
          }
        }
        acc.min = min;
        acc.max = max;
      }
      accessors.push(acc);
      offset += f.byteLength;
    }
    primitives.push({ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: mat });
  }
  const bytes = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) {
    bytes.set(new Uint8Array(c.buffer), o);
    o += c.byteLength;
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const gltf = {
    asset: { version: "2.0", generator: "open-naval-sim procedural models" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials: colours.map((c) => ({
      pbrMetallicRoughness: { baseColorFactor: c, metallicFactor: 0.2, roughnessFactor: 0.8 }, doubleSided: true, ...(c[3] < 1 ? { alphaMode: "BLEND" } : {}),
    })),
    buffers: [{ byteLength: offset, uri: `data:application/octet-stream;base64,${btoa(bin)}` }],
    bufferViews,
    accessors,
  };
  return `data:model/gltf+json;base64,${btoa(JSON.stringify(gltf))}`;
}
