// Passive ESM / radar warning receivers, ported from GCB2 src/sim/tcESMSensor.cpp
// (CanDetectTarget, IsDetectedRadar, IsDetected). An ESM receiver hears an emitting radar
// when its frequency is in band, both antennas are within each other's radar horizon, and
// ERP + 20 log(refRange / range) clears the detection window. It measures bearing only.
// Not ported: ECM emitters, terrain line of sight.

import { DEG, RADAR_HORIZON_K, bearing, groundRange_m, wrapPi } from "./geo.js";
import { randomDetect } from "./radar.js";

export class EsmSensor {
  constructor(db, parent, { mountAz_rad = 0, sensorHeight_m = 0 } = {}) {
    this.db = db;
    this.parent = parent;
    this.mountAz = mountAz_rad;
    this.sensorHeight_m = sensorHeight_m;
    this.active = true; // passive: always listening unless damaged
    this.lastScan = -1e9;
    this.kind = "esm";
  }

  /** Radars a target is radiating with: active, non-semi-active search/FC radars or an active seeker. */
  emitters(target) {
    if (target.dead) return [];
    if (target.kind === "missile") {
      const s = target.seeker;
      return s && s.kind === "radar" && s.active && !s.db.isSemiactive ? [s] : [];
    }
    return (target.radars || []).filter((r) => r.kind === "radar" && r.active && !r.db.isSemiactive);
  }

  /**
   * @returns {{bearing, margin_dB, emitter}|null} the strongest detected emitter on the target
   * (bearing is the true bearing; the world adds the receiver's bias)
   */
  detect(target) {
    if (!this.active || this.parent.dead) return null;
    const p = this.parent;
    const db = this.db;
    let best = null;
    for (const r of this.emitters(target)) {
      const f = r.db.freq_Hz;
      if (!(f >= db.minFreq_Hz && f <= db.maxFreq_Hz)) continue;
      const brg = bearing(p, target);
      if (db.fov_deg < 360 && Math.abs(wrapPi(brg - (p.heading + this.mountAz))) > 0.5 * db.fov_deg * DEG) continue;
      // emitter must be pointing our way (sector-scan radars and seekers)
      if (r.db.fov_deg < 360) {
        const back = brg + Math.PI;
        if (Math.abs(wrapPi(back - (target.heading + r.mountAz))) > 0.5 * r.db.fov_deg * DEG) continue;
      }
      const horizon_km = RADAR_HORIZON_K * (Math.sqrt(Math.max(target.alt + (r.sensorHeight_m || 0), 0)) + Math.sqrt(Math.max(p.alt + this.sensorHeight_m, 0)));
      const range_km = groundRange_m(p, target) / 1000;
      if (range_km > horizon_km || range_km > db.maxRange_km) continue;
      const margin_dB = r.db.erpPeak_dBW + 20 * (Math.log10(db.refRange_km) - Math.log10(Math.max(range_km, 0.001)));
      if (!randomDetect(margin_dB, p.world.rng)) continue;
      if (!best || margin_dB > best.margin_dB) best = { bearing: brg, margin_dB, emitter: r.db.name, range_km };
    }
    return best;
  }
}
