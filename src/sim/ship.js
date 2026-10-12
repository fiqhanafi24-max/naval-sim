// Surface ship: simple kinematics (accelerate / turn toward ordered course and speed),
// a radar fit and missile launchers taken from the GCB2 database.

import { EsmSensor } from "./esm.js";
import { createSensor } from "./optical.js";
import { DEG, KTS_TO_MPS, advance, bearing, groundRange_m, wrapPi, wrap2Pi } from "./geo.js";

const DEFAULT_CYCLE_S = 2;
const WAYPOINT_REACHED_M = 1000;

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
    this.route = (spec.route || []).map((w) => ({ lat: w.lat_deg * DEG, lon: w.lon_deg * DEG }));
    this.throttle = null;

    // GCB2 places sensors at 80% of the model height; effective height is about 40% of it
    const sensorHeight_m = 2 * (db.effectiveHeight_m || 10);
    // all sensors (radars and lookouts); the name is historical
    this.radars = db.sensors.filter((s) => s.type !== "esm").map((s) => createSensor(world, s, this, sensorHeight_m));
    this.esm = db.sensors.filter((s) => s.type === "esm")
      .map((s) => new EsmSensor(world.data.esms[s.name], this, { mountAz_rad: s.mountAz_deg * DEG, sensorHeight_m }));
    this.magazine = { ...(db.magazine || {}) };
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

  /** A direct course order cancels any plotted route. */
  order({ heading_deg, speed_kts }) {
    if (heading_deg != null) {
      this.goalHeading = wrap2Pi(heading_deg * DEG);
      this.route = [];
    }
    if (speed_kts != null) {
      this.goalSpeed_kts = Math.max(0, speed_kts);
      this.throttle = null;
    }
  }

  /** Throttle presets as fractions of maximum speed; creep is a fixed quiet speed. */
  setThrottle(preset) {
    const max = this.db.maxSpeed_kts;
    const speeds = { stop: 0, creep: Math.min(5, max), cruise: 0.6 * max, full: 0.85 * max, flank: max };
    if (!(preset in speeds)) return;
    this.throttle = preset;
    this.goalSpeed_kts = Math.round(speeds[preset]);
  }

  /** Plotted course: the ship steers for each waypoint {lat, lon} in turn. */
  setRoute(waypoints) {
    this.route = waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
  }

  update(dt) {
    if (this.route.length) {
      if (groundRange_m(this, this.route[0]) < WAYPOINT_REACHED_M) this.route.shift();
      if (this.route.length) this.goalHeading = bearing(this, this.route[0]);
    }

    const goalSpeed = Math.min(this.goalSpeed_kts, this.maxSpeed_kts);
    const dv = Math.max(-this.db.accel_ktsps * dt, Math.min(this.db.accel_ktsps * dt, goalSpeed - this.speed_kts));
    this.speed_kts = Math.max(0, this.speed_kts + dv);

    const maxTurn = this.db.turnRate_degps * DEG * dt;
    const dh = Math.max(-maxTurn, Math.min(maxTurn, wrapPi(this.goalHeading - this.heading)));
    if (this.speed_kts > 0.5) this.heading = wrap2Pi(this.heading + dh);

    advance(this, this.speed_kts * KTS_TO_MPS * dt, this.heading);
  }

  /** Weapons remaining (ready plus magazine), grouped by weapon name. */
  inventory() {
    const inv = {};
    for (const l of this.launchers) inv[l.item] = (inv[l.item] || 0) + l.count;
    for (const [item, n] of Object.entries(this.magazine)) inv[item] = (inv[item] || 0) + n;
    return inv;
  }

  /**
   * Refill an empty gun mount from the magazine after its reload time.
   * @returns {boolean} true if the mount has ready rounds
   */
  reload(L, t) {
    if (L.count > 0) return true;
    if (!(this.magazine[L.item] > 0)) return false;
    if (L.reloadDoneAt == null) {
      L.reloadDoneAt = t + (L.reload_s || 0);
      return false;
    }
    if (t < L.reloadDoneAt) return false;
    const n = Math.min(L.capacity || 1, this.magazine[L.item]);
    L.count += n;
    this.magazine[L.item] -= n;
    L.reloadDoneAt = null;
    return true;
  }
}
