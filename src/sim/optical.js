// Optical and infrared seekers, ported from GCB2 src/sim/tcOpticalSensor.cpp (CanDetectTarget,
// CalculateTargetSignature). Same interface as Radar so missiles can use either as a seeker.
// Not ported: day/night (always daylight), laser designation, sea state.

import { DEG, bearing, range3D_m, wrapPi } from "./geo.js";
import { randomDetect, signatureModifier } from "./radar.js";

const VISUAL_HORIZON_K = 2.78; // km per sqrt(m), C_VISUALHOR
const IR_EXTINCTION = 0.25;

export class OpticalSensor {
  constructor(db, parent, { mountAz_rad = 0, sensorHeight_m = 0 } = {}) {
    this.db = db;
    this.parent = parent;
    this.mountAz = mountAz_rad;
    this.sensorHeight_m = sensorHeight_m;
    this.active = true;
    this.lastScan = -1e9;
    this.illuminator = null;
    this.lastMargin_dB = -99;
  }

  /** IR signature (aspect-dependent) or optical cross-section of the target, in dB. */
  targetSignature(target, targetAz) {
    const tdb = target.db;
    if (this.db.isIR) {
      const aspect = wrapPi(targetAz - target.heading + Math.PI);
      const sig = target.world.data.signatures[tdb.irModel];
      return (tdb.irSignature_dB ?? -999) + signatureModifier(sig, aspect / DEG);
    }
    return tdb.opticalCrossSection_dBsm ?? -999;
  }

  canDetect(target, useRandom = false) {
    this.lastMargin_dB = -99;
    if (!this.active || target.dead || target.alt < -18) return false;
    const db = this.db;
    const p = this.parent;

    const isMissile = target.kind === "missile";
    const isSurface = target.kind === "ship";
    const isAir = target.kind === "aircraft";
    const typeMatch = (db.detectsAir && isAir) || (db.detectsMissile && isMissile) || (db.detectsSurface && isSurface);
    if (!typeMatch) return false;

    const targetAz = bearing(p, target);
    if (db.fov_deg < 360) {
      const look = p.heading + this.mountAz;
      if (Math.abs(wrapPi(targetAz - look)) > 0.5 * db.fov_deg * DEG) return false;
    }

    const targetAlt = target.alt + (target.db.effectiveHeight_m || 0);
    const horizon_km = VISUAL_HORIZON_K * (Math.sqrt(Math.max(targetAlt, 0)) + Math.sqrt(Math.max(p.alt + this.sensorHeight_m, 0)));
    const range_km = range3D_m(p, target) / 1000;
    if (range_km > horizon_km || range_km > db.maxRange_km) return false;

    // visual extinction falls with air density at both ends; GCB2 uses a fixed value for IR
    let extinction = IR_EXTINCTION;
    if (!db.isIR) {
      const atm = p.world.atmosphere;
      extinction = 0.5 * ((atm.density(Math.max(target.alt, 0)) / 1.255) * 0.75 + (atm.density(Math.max(p.alt, 0)) / 1.225) * 0.75);
    }
    const atten_dB = extinction * (db.refRange_km - range_km);
    const margin_dB =
      20 * (Math.log10(db.refRange_km) - Math.log10(Math.max(range_km, 0.001))) + this.targetSignature(target, targetAz) + atten_dB;
    this.lastMargin_dB = margin_dB;
    if (useRandom) return randomDetect(margin_dB, p.world.rng);
    return margin_dB >= 0;
  }
}
