// Surface ship: simple kinematics (accelerate / turn toward ordered course and speed),
// a radar fit and missile launchers taken from the GCB2 database.

import { Radar } from "./radar.js";
import { DEG, KTS_TO_MPS, advance, wrapPi, wrap2Pi } from "./geo.js";

const DEFAULT_CYCLE_S = 2;

export class Ship {
  constructor(world, db, spec) {
    this.world = world;
    this.db = db;
    this.kind = "ship";
    this.id = world.nextId++;
    this.name = spec.name || db.name;
    this.side = spec.side;
    this.dead = false;
    this.damage = 0;

    this.lat = spec.lat_deg * DEG;
    this.lon = spec.lon_deg * DEG;
    this.alt = 0;
    this.pitch = 0;
    this.heading = wrap2Pi((spec.heading_deg || 0) * DEG);
    this.speed_kts = spec.speed_kts || 0;
    this.goalHeading = this.heading;
    this.goalSpeed_kts = this.speed_kts;

    // GCB2 places sensors at 80% of the model height; effective height is about 40% of it
    const sensorHeight_m = 2 * (db.effectiveHeight_m || 10);
    this.radars = db.sensors.map(
      (s) => new Radar(world.data.radars[s.name], this, { mountAz_rad: s.mountAz_deg * DEG, sensorHeight_m }),
    );
    // entries with the same launcher id (e.g. SM-1 and Harpoon on a Mk-13 arm) share one reload timer
    const arms = new Map();
    this.launchers = db.launchers.map((l) => ({
      ...l,
      count: l.count,
      arm: arms.get(l.id) || arms.set(l.id, { lastFire: -1e9 }).get(l.id),
      cycle_s: l.cycle_s ?? DEFAULT_CYCLE_S,
      fc: l.fireControl ? this.radars.find((r) => r.db.name === l.fireControl) || null : null,
    }));
  }

  get maxSpeed_kts() {
    return this.db.maxSpeed_kts * (1 - this.damage);
  }

  order({ heading_deg, speed_kts }) {
    if (heading_deg != null) this.goalHeading = wrap2Pi(heading_deg * DEG);
    if (speed_kts != null) this.goalSpeed_kts = Math.max(0, speed_kts);
  }

  update(dt) {
    const goalSpeed = Math.min(this.goalSpeed_kts, this.maxSpeed_kts);
    const dv = Math.max(-this.db.accel_ktsps * dt, Math.min(this.db.accel_ktsps * dt, goalSpeed - this.speed_kts));
    this.speed_kts = Math.max(0, this.speed_kts + dv);

    const maxTurn = this.db.turnRate_degps * DEG * dt;
    const dh = Math.max(-maxTurn, Math.min(maxTurn, wrapPi(this.goalHeading - this.heading)));
    if (this.speed_kts > 0.5) this.heading = wrap2Pi(this.heading + dh);

    advance(this, this.speed_kts * KTS_TO_MPS * dt, this.heading);
  }

  /** Weapons remaining, grouped by missile name. */
  inventory() {
    const inv = {};
    for (const l of this.launchers) inv[l.item] = (inv[l.item] || 0) + l.count;
    return inv;
  }
}
