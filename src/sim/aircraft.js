// Aircraft: patrol (radar search orbit) and strike (fly to launch range, fire anti-ship missiles,
// return) missions. Kinematics follow GCB2's simple air model (tcAirObject: speed, turn rate,
// climb rate, fuel burn); GCB2 flies jets with a full aero model, which isn't ported.
// Not ported yet: fighters, air-to-air weapons, countermeasures, take-off and landing.

import { createSensor } from "./optical.js";
import { DEG, KTS_TO_MPS, advance, bearing, groundRange_m, offset, wrapPi, wrap2Pi } from "./geo.js";

const HOME_RADIUS_M = 5000;
const ORBIT_POINTS = 8;
const FUEL_RESERVE = 0.1;

export class Aircraft {
  /**
   * @param {object} spec {side, name, lat_deg, lon_deg, heading_deg, alt_m, mission, home}
   *   mission: {type: "patrol", center: {lat_deg, lon_deg}, radius_km, alt_m}
   *          | {type: "strike", targetId, alt_m}
   *   home: {lat_deg, lon_deg} where the aircraft leaves the map
   */
  constructor(world, db, spec) {
    this.world = world;
    this.db = db;
    this.kind = "aircraft";
    this.id = world.nextId++;
    this.name = spec.name || db.name;
    this.side = spec.side;
    this.dead = false;
    this.damage = 0;
    this.lat = spec.lat_deg * DEG;
    this.lon = spec.lon_deg * DEG;
    this.alt = spec.alt_m ?? 3000;
    this.heading = wrap2Pi((spec.heading_deg || 0) * DEG);
    this.pitch = 0;
    this.speed_kts = db.cruiseSpeed_kts;
    this.goalHeading = this.heading;
    this.goalAlt = this.alt;
    this.goalSpeed_kts = db.cruiseSpeed_kts;
    this.fuel_kg = db.fuel_kg * (spec.fuelFraction ?? 1);
    this.home = { lat: (spec.home?.lat_deg ?? spec.lat_deg) * DEG, lon: (spec.home?.lon_deg ?? spec.lon_deg) * DEG };
    this.mission = { ...spec.mission };
    this.status = this.mission.type;
    this.orbitIndex = 0;

    this.radars = db.sensors.map((s) => createSensor(world, s, this));
    const arms = new Map();
    this.launchers = db.launchers.map((l) => ({
      ...l,
      arm: arms.get(l.id) || arms.set(l.id, { lastFire: -1e9 }).get(l.id),
      fc: null,
    }));
    this.magazine = {};
  }

  inventory() {
    const inv = {};
    for (const l of this.launchers) inv[l.item] = (inv[l.item] || 0) + l.count;
    return inv;
  }

  get fuelFraction() {
    return this.db.fuel_kg > 0 ? this.fuel_kg / this.db.fuel_kg : 1;
  }

  /** Fuel needed to fly home at cruise speed, with a reserve. */
  bingo() {
    const t_s = groundRange_m(this, this.home) / (this.db.cruiseSpeed_kts * KTS_TO_MPS);
    return this.fuel_kg < t_s * this.db.fuelRate_kgps + FUEL_RESERVE * this.db.fuel_kg;
  }

  returnToBase(reason) {
    if (this.status === "rtb") return;
    this.status = "rtb";
    if (reason) this.world.log(this.side, `${this.name} returning to base: ${reason}`, "info");
  }

  update(dt) {
    this.runMission();

    // speed, heading and altitude toward goals (tcAirObject-style rate limits)
    const dv = this.db.accel_ktsps * dt;
    this.speed_kts += Math.max(-dv, Math.min(dv, this.goalSpeed_kts - this.speed_kts));
    const maxTurn = this.db.turnRate_degps * DEG * dt;
    this.heading = wrap2Pi(this.heading + Math.max(-maxTurn, Math.min(maxTurn, wrapPi(this.goalHeading - this.heading))));
    const goalAlt = Math.min(this.goalAlt, this.db.maxAlt_m);
    const climb = Math.max(-this.db.climbRate_mps, Math.min(this.db.climbRate_mps, (goalAlt - this.alt) / Math.max(dt, 1e-3)));
    const v = this.speed_kts * KTS_TO_MPS;
    this.alt += climb * dt;
    this.pitch = Math.asin(Math.max(-1, Math.min(1, climb / Math.max(v, 1))));
    advance(this, v * Math.cos(this.pitch) * dt, this.heading);

    this.fuel_kg -= this.db.fuelRate_kgps * dt;
    if (this.fuel_kg <= 0) return this.world.destroy(this, null, "ran out of fuel and ditched");
  }

  runMission() {
    if (this.status !== "rtb" && this.bingo()) this.returnToBase("fuel");
    if (this.status === "rtb") return this.flyHome();
    if (this.mission.type === "patrol") return this.patrol();
    if (this.mission.type === "strike") return this.strike();
  }

  flyHome() {
    this.goalHeading = bearing(this, this.home);
    this.goalSpeed_kts = this.db.cruiseSpeed_kts;
    if (groundRange_m(this, this.home) < HOME_RADIUS_M) this.world.recoverAircraft(this);
  }

  /** Fly a circle of waypoints around the patrol centre. */
  patrol() {
    const m = this.mission;
    const center = { lat: m.center.lat_deg * DEG, lon: m.center.lon_deg * DEG };
    const wp = offset(center, (this.orbitIndex / ORBIT_POINTS) * 2 * Math.PI, 1000 * m.radius_km);
    if (groundRange_m(this, wp) < 3000) this.orbitIndex = (this.orbitIndex + 1) % ORBIT_POINTS;
    this.goalHeading = bearing(this, wp);
    this.goalAlt = m.alt_m;
    this.goalSpeed_kts = this.db.cruiseSpeed_kts;
  }

  /** Fly toward the target track; at launch range, fire every anti-ship missile, then go home. */
  strike() {
    const world = this.world;
    const m = this.mission;
    const track = world.getTrack(this.side, m.targetId);
    if (!track) return this.returnToBase("lost target track");
    const datum = { lat: track.lat, lon: track.lon };
    this.goalHeading = bearing(this, datum);
    this.goalAlt = m.alt_m;
    this.goalSpeed_kts = this.db.cruiseSpeed_kts;

    const asm = this.launchers.filter((l) => l.count > 0);
    if (!asm.length) return this.returnToBase(m.fired ? null : "no weapons");
    const reach_km = Math.min(...asm.map((l) => world.data.missiles[l.item].maxRange_km)) * (m.launchFraction ?? 0.6);
    const range_km = groundRange_m(this, datum) / 1000;
    // attack run: speed up before launch so boosterless missiles (e.g. AGM-84A) leave fast enough
    // to pass GCB2's 20 s shutdown-speed check
    if (range_km < 1.5 * reach_km) {
      this.goalSpeed_kts = Math.min(0.85 * this.db.maxSpeed_kts, 1.4 * this.db.cruiseSpeed_kts);
    }
    if (range_km > reach_km || this.speed_kts < 0.95 * this.goalSpeed_kts) return;
    for (let i = 0; i < this.launchers.length; i++) {
      if (this.launchers[i].count > 0 && world.launch(this, i, m.targetId).ok) m.fired = (m.fired || 0) + 1;
    }
    if (!this.launchers.some((l) => l.count > 0)) {
      world.log(this.side, `${this.name} fired ${m.fired} x ${this.launchers[0].item} at ${world.trackName(track)}`, "launch");
      this.returnToBase(null);
    }
  }
}
