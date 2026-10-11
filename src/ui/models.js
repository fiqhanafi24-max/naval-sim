// Procedural low-poly ship models, built as glTF in memory so the project needs no
// third-party model files. Dimensions come from the GCB2 database (length, beam, height).
//
// glTF is Y-up; Cesium converts it to Z-up. The ship is built with +X toward the bow,
// +Y up and +Z to port, so it orients like the hull boxes (heading - 90°).

const HAZE_GREY = [0.55, 0.58, 0.6, 1];
const SOVIET_GREY = [0.45, 0.5, 0.53, 1];
const DECK = [0.33, 0.35, 0.36, 1];
const HULL_RED = [0.42, 0.16, 0.14, 1];

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
 * Build a warship mesh.
 * @param {{length_m, beam_m, effectiveHeight_m}} dims
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

  // superstructure: forward block with bridge, aft hangar block, funnel(s), mast
  const y0 = freeboard;
  const ss = 0.32 * B;
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
    asset: { version: "2.0", generator: "open-naval-sim procedural ships" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials: colours.map((c) => ({ pbrMetallicRoughness: { baseColorFactor: c, metallicFactor: 0.2, roughnessFactor: 0.8 }, doubleSided: true })),
    buffers: [{ byteLength: offset, uri: `data:application/octet-stream;base64,${btoa(bin)}` }],
    bufferViews,
    accessors,
  };
  return `data:model/gltf+json;base64,${btoa(JSON.stringify(gltf))}`;
}
