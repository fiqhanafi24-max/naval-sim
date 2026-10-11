// Radar detection model, ported from GCB2 src/sim/tcRadar.cpp (CanDetectTarget and helpers)
// and tcSensorState::RandomDetect. Jamming and terrain line-of-sight are not ported yet.

import { DEG, KTS_TO_MPS, RADAR_HORIZON_K, bearing, range3D_m, wrapPi } from "./geo.js";

/** Aspect-dependent RCS modifier (port of tcSignatureModel::GetModifier). Table is 0..180 deg in 10 deg steps. */
export function signatureModifier(table, aspect_deg) {
  if (!table) return 0;
  let a = ((aspect_deg % 360) + 360) % 360;
  if (a > 180) a = 360 - a; // tables are symmetric port/starboard
  const x = a / 10;
  const i = Math.min(Math.floor(x), table.length - 2);
  const alpha = x - i;
  return (1 - alpha) * table[i] + alpha * table[i + 1];
}

export class Radar {
  /**
   * @param {object} db radar database record
   * @param {object} parent ship or missile carrying the radar
   * @param {object} opts {mountAz_rad, sensorHeight_m}
   */
  constructor(db, parent, { mountAz_rad = 0, sensorHeight_m = 0 } = {}) {
    this.db = db;
    this.parent = parent;
    this.mountAz = mountAz_rad;
    this.sensorHeight_m = sensorHeight_m;
    this.active = true;
    this.lastScan = -1e9;
    this.illuminator = null; // fire-control radar feeding a semi-active seeker
    this.fcTargets = new Map(); // targetId -> count of weapons this radar is guiding
    this.lastMargin_dB = -99;
  }

  get isWeapon() {
    return this.parent.kind === "missile";
  }

  fcChannelsFree() {
    return this.db.maxFireControlTracks - this.fcTargets.size;
  }

  requestTrack(targetId) {
    if (!this.fcTargets.has(targetId) && this.fcChannelsFree() <= 0) return false;
    this.fcTargets.set(targetId, (this.fcTargets.get(targetId) || 0) + 1);
    return true;
  }

  releaseTrack(targetId) {
    const n = (this.fcTargets.get(targetId) || 0) - 1;
    if (n <= 0) this.fcTargets.delete(targetId);
    else this.fcTargets.set(targetId, n);
  }

  /** Port of tcRadar::CalculateTargetRCS_dBsm, including the blind-speed penalty. */
  targetRCS(target, targetAz) {
    const sig = target.world.data.signatures[target.db.rcsModel];
    const aspect = wrapPi(targetAz - target.heading + Math.PI);
    let rcs = target.db.rcs_dBsm + signatureModifier(sig, aspect / DEG);
    if (this.db.blindSpeed_mps > 0) {
      const radial_mps = Math.abs(target.speed_kts * KTS_TO_MPS * Math.cos(aspect));
      const f = radial_mps / this.db.blindSpeed_mps;
      if (f < 1) rcs -= 24;
      else if (f < 2) rcs -= 24 * (2 - f);
    }
    return rcs;
  }

  /** Elevation coverage; weapons use a cone around the boresight (TargetInElevationCoverageWeapon). */
  inElevationCoverage(target, range_m) {
    const p = this.parent;
    const dalt = target.alt - p.alt;
    const sinEl = Math.max(-1, Math.min(1, dalt / Math.max(range_m, 1)));
    if (!this.isWeapon) {
      const el = Math.asin(sinEl);
      return { ok: el >= this.db.minEl_deg * DEG && el <= this.db.maxEl_deg * DEG, el };
    }
    const cp = Math.cos(p.pitch);
    const brg = bearing(p, target);
    const cosEl = Math.sqrt(1 - sinEl * sinEl);
    const cosCone =
      cp * Math.cos(p.heading) * cosEl * Math.cos(brg) + cp * Math.sin(p.heading) * cosEl * Math.sin(brg) + Math.sin(p.pitch) * sinEl;
    const cone = Math.acos(Math.max(-1, Math.min(1, cosCone)));
    return { ok: cone <= this.db.maxEl_deg * DEG, el: cone };
  }

  /**
   * Port of tcRadar::CanDetectTarget.
   * @param {boolean} useRandom apply the probabilistic detection window (search radars)
   */
  canDetect(target, useRandom = false) {
    this.lastMargin_dB = -99;
    if (!this.active || target.dead) return false;
    const db = this.db;
    const p = this.parent;

    let illumRange_km = 1e8;
    if (db.isSemiactive) {
      const illum = this.illuminator;
      if (!illum || !illum.active || illum.parent.dead) return false;
      if (!illum.canDetect(target, false)) return false;
      illumRange_km = range3D_m(illum.parent, target) / 1000;
    }

    const targetHeight_m = target.alt + (target.db.effectiveHeight_m || 0);
    if (target.alt < 0) return false; // submerged

    const targetAz = bearing(p, target);
    let rcs = this.targetRCS(target, targetAz);

    const isMissile = target.kind === "missile";
    const isSurface = target.kind === "ship";
    // aircraft are air targets; subsonic missiles count as air targets too
    const isAir = target.kind === "aircraft" || (isMissile && target.speed_kts < 600);

    if (db.fov_deg < 360) {
      const look = p.heading + this.mountAz;
      if (Math.abs(wrapPi(targetAz - look)) > 0.5 * db.fov_deg * DEG) return false;
    }

    const clutterHorizon_km = RADAR_HORIZON_K * Math.sqrt(Math.max(p.alt + this.sensorHeight_m, 0));
    const radarHorizon_km = RADAR_HORIZON_K * Math.sqrt(Math.max(targetHeight_m, 0)) + clutterHorizon_km;
    const range_m = range3D_m(p, target);
    const range_km = range_m / 1000;
    if (range_km > radarHorizon_km || range_km > db.maxRange_km) return false;

    const cov = this.inElevationCoverage(target, range_m);
    if (!cov.ok) return false;

    // look-down clutter (tcRadar::CalculateClutterAdjustment_dB), all-ocean for now
    if (range_km <= clutterHorizon_km && cov.el <= 0.5 * db.elBeamwidth_deg * DEG) {
      rcs += db.lookdownWater_dB;
    }

    const typeMatch =
      (db.detectsAir && isAir) || (db.detectsMissile && isMissile) || (db.detectsSurface && isSurface);
    if (!typeMatch) return false;

    const r = Math.max(range_km, 0.001);
    const margin_dB = db.isSemiactive
      ? 20 * (2 * Math.log10(db.refRange_km) - Math.log10(r) - Math.log10(Math.max(illumRange_km, 0.001))) + rcs
      : 40 * (Math.log10(db.refRange_km) - Math.log10(r)) + rcs;
    this.lastMargin_dB = margin_dB;

    if (useRandom) return randomDetect(margin_dB, p.world.rng);
    return margin_dB >= 0;
  }

  /** Approximate detection range against a target RCS, for range rings in the UI. */
  nominalRange_km(rcs_dBsm, targetHeight_m) {
    const snrRange = this.db.refRange_km * Math.pow(10, rcs_dBsm / 40);
    const horizon =
      RADAR_HORIZON_K * (Math.sqrt(Math.max(targetHeight_m, 0)) + Math.sqrt(this.parent.alt + this.sensorHeight_m));
    return Math.min(snrRange, horizon, this.db.maxRange_km);
  }
}

/** Port of tcSensorState::RandomDetect: linear Pd ramp across +/-3 dB of margin. */
export function randomDetect(margin_dB, rng) {
  const window = 3;
  if (margin_dB < -window) return false;
  if (margin_dB >= window) return true;
  return rng.next() <= 0.1666 * (margin_dB + window);
}

