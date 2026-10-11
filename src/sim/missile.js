// Guided missile, ported from GCB2 src/sim/tcMissileObject.cpp (Update, UpdateGuidance,
// UpdateGoalPitch, UpdateDetonation) and Aero::UpdateMissileKState (src/sim/tcAero.cpp).
//
// Differences from GCB2, kept deliberately small:
//  - a seeker that has not yet acquired steers on the launching side's track of its target
//    (stands in for GCB2's SEEKERACQUIRE / command-handoff logic);
//  - collision with a ship uses its length/beam/height box instead of the 3D model mesh;
//  - command-only missiles switch to intercept pitch in the last 15 s (otherwise ESSM's
//    12,000 m altitude hold flies it over sea-skimmers until the motor burns out);
//  - a tracking seeker coasts on its last track for up to 3 s when it briefly loses the target.

import { Radar } from "./radar.js";
import {
  DEG, KTS_TO_MPS, MPS_TO_KTS, G_MPS2, advance, bearing, closestApproach, enu,
  groundRange_m, interceptData3D, range3D_m, velocity, wrapPi, wrap2Pi,
} from "./geo.js";

const GM_COMMAND = 0, GM_NAV = 1, GM_SENSOR = 2;
const AM_ASL = 0, AM_AGL = 1, AM_INTERCEPT = 2, AM_DATUM = 3, AM_INTERCEPT_HIGH = 4, AM_ASL_LOFT = 5;
const IGNORE_ALT = -9999;
const TERMINAL_COMMAND_S = 15;
const SEEKER_COAST_S = 3;

let missileCounter = 0;

/** Predict a snapshot {lat, lon, alt, heading, pitch, speed_kts, t} forward to time t. */
export function predict(snap, t) {
  const p = { ...snap };
  const dt = t - snap.t;
  if (dt > 0) {
    const v = velocity(snap);
    advance(p, Math.hypot(v.x, v.y) * dt, snap.heading);
    p.alt = snap.alt + v.z * dt;
    p.t = t;
  }
  return p;
}

export class Missile {
  /**
   * @param {object} world
   * @param {object} db missile database record
   * @param {object} o {shooter, launcher, targetId, datum, fcRadar}
   */
  constructor(world, db, { shooter, launcher, targetId, datum, fcRadar }) {
    this.world = world;
    this.db = db;
    this.kind = "missile";
    this.id = world.nextId++;
    this.name = `${db.name} #${++missileCounter}`;
    this.side = shooter.side;
    this.shooterId = shooter.id;
    this.dead = false;
    this.damage = 0;

    this.lat = shooter.lat;
    this.lon = shooter.lon;
    this.alt = Math.max(shooter.alt, 5);
    this.speed_mps = shooter.speed_kts * KTS_TO_MPS;
    this.speed_kts = shooter.speed_kts;
    this.groundSpeed_mps = this.speed_mps;
    this.flightTime = 0;
    this.distanceFromLaunch = 0;

    const el = (launcher?.el_deg ?? 0) * DEG;
    this.pitch = el;
    // VLS (near-vertical) launches point toward the target; others leave along the launcher bearing
    this.heading = el > 1.4835 ? bearing(shooter, datum) : wrap2Pi(shooter.heading + (launcher?.az_deg ?? 0) * DEG);
    this.goalHeading = bearing(shooter, datum);
    this.goalPitch = this.pitch;
    this.goalAlt = IGNORE_ALT;

    this.segment = 0;
    this.lastGuidance = -1e9;
    this.guidanceInterval = 0.5;
    this.rangeToObjective_km = groundRange_m(shooter, datum) / 1000;
    this.interceptTime = 9999;
    this.waypoint = { lat: datum.lat, lon: datum.lon, alt: db.detonationRange_m };
    this.intendedTarget = targetId;
    this.malfunctionChecked = false;
    this.directHitTargetId = null;
    this.trail = [];

    this.fcRadar = fcRadar || null;
    this.seeker = null;
    this.seekerMode = "off"; // off | search | acquire | track
    this.seekerTargetId = null;
    this.seekerSnap = null;
    if (db.seeker && world.data.radars[db.seeker]) {
      this.seeker = new Radar(world.data.radars[db.seeker], this);
      this.seeker.active = false;
      this.seeker.illuminator = fcRadar || null;
      if (fcRadar) {
        // FC_TRACK launch: seeker cued onto the designated target
        this.seeker.active = true;
        this.seekerMode = "acquire";
        this.seekerTargetId = targetId;
        this.seeker.lastScan = -10;
      }
    }
  }

  get profile() {
    return this.db.profile;
  }

  gLimitedTurnRate() {
    return (19.0691 * this.db.gMax) / (this.speed_kts + 0.1);
  }

  closingSpeed_mps(target) {
    const vm = velocity(this);
    const vt = velocity(target);
    return Math.hypot(vm.x - vt.x, vm.y - vt.y, vm.z - vt.z);
  }

  /** Aero::UpdateMissileKState: thrust, Mach-dependent drag, gravity along the flight path. */
  updateAero(dt) {
    const db = this.db;
    const atm = this.world.atmosphere;
    const rhv2 = atm.density(Math.max(this.alt, 0)) * this.speed_mps * this.speed_mps;
    const mach = this.speed_mps / atm.soundSpeed(Math.max(this.alt, 0));
    const mtran = 0.5 * (db.mcm + db.msupm);
    let k;
    if (mach <= db.mcm) k = db.cdpsub;
    else if (mach >= db.msupm) k = db.cdpsup;
    else if (mach <= mtran) k = ((mach - db.mcm) * (db.cdptran - db.cdpsub)) / (mtran - db.mcm) + db.cdpsub;
    else k = ((db.msupm - mach) * (db.cdptran - db.cdpsup)) / (db.msupm - mtran) + db.cdpsup;

    const drag = rhv2 * k;
    let thrust = 0;
    if (this.flightTime <= db.boostTime_s) thrust = db.boostThrust_N;
    else if (this.flightTime <= db.boostTime_s + db.sustTime_s) thrust = db.sustThrust_N;
    if (this.pitch !== 0) thrust -= db.weight_kg * G_MPS2 * Math.sin(this.pitch);

    this.speed_mps = Math.max(this.speed_mps + ((thrust - drag) / db.weight_kg) * dt, 0);
    this.groundSpeed_mps = this.speed_mps * Math.cos(this.pitch);
    this.alt += this.speed_mps * Math.sin(this.pitch) * dt;
    this.flightTime += dt;
  }

  update(dt, t) {
    this.updateAero(dt);
    this.speed_kts = this.speed_mps * MPS_TO_KTS;
    const d = this.groundSpeed_mps * dt;
    advance(this, d, this.heading);
    this.distanceFromLaunch += d;

    this.updateGuidance(t);
    if (this.dead) return;

    const maxTurn = dt * Math.min(this.gLimitedTurnRate(), this.db.maxTurnRate_degps * DEG);
    const dh = Math.max(-maxTurn, Math.min(maxTurn, wrapPi(this.goalHeading - this.heading)));
    this.heading = wrap2Pi(this.heading + dh);

    this.updateGoalPitch();
    const dp = Math.max(-maxTurn, Math.min(maxTurn, this.goalPitch - this.pitch));
    this.pitch += dp;

    this.updateSeeker(t);
    if (this.dead) return;
    this.updateDetonation(dt);
    if (this.dead) return;

    if (this.alt <= 0) return this.world.removeMissile(this, "hit the sea");
    if (this.flightTime > 20 && this.speed_mps < this.db.shutdownSpeed_mps) {
      return this.world.removeMissile(this, "motor burnout, fell short");
    }
  }

  /** Port of UpdateGoalPitch: proportional altitude hold. */
  updateGoalPitch() {
    if (this.goalAlt === IGNORE_ALT) return;
    const dAlt = this.alt - this.goalAlt;
    if (Math.abs(dAlt) < 0.5) {
      this.goalPitch = 0;
      return;
    }
    const aczConstant = KTS_TO_MPS * (50 / Math.max(Math.min(this.db.gMax, 20), 0.1));
    const acz = Math.max(aczConstant * this.speed_kts, 1e-3);
    const seg = this.profile[this.segment];
    if (dAlt < -acz) this.goalPitch = seg && seg.altMode === AM_ASL_LOFT ? 0.349 : 1.0;
    else if (dAlt > acz) this.goalPitch = -1.0;
    else this.goalPitch = -dAlt / acz;
  }

  /** Steer toward a predicted track position; returns intercept pitch. */
  steerToward(predicted, useLead) {
    // aim at the hull, not the waterline (GCB2 collides with the 3D model, which sits above alt 0)
    const ship = predicted.kind === "ship" ? this.world.data.ships[predicted.className] : null;
    const aim = ship ? { ...predicted, alt: predicted.alt + ship.effectiveHeight_m } : predicted;
    const ic = interceptData3D(this, aim);
    this.goalHeading = useLead && this.flightTime >= 5 ? ic.heading : bearing(this, aim);
    this.rangeToObjective_km = groundRange_m(this, aim) / 1000;
    this.interceptTime = ic.tti_s;
    this.waypoint = { lat: predicted.lat, lon: predicted.lon, alt: predicted.alt };
    return this.alt <= 4 && ic.pitch < 0 ? 0 : ic.pitch;
  }

  /** Port of UpdateGuidance. */
  updateGuidance(t) {
    if (this.flightTime - this.lastGuidance < this.guidanceInterval) return;
    this.lastGuidance = this.flightTime;
    const seg = this.profile[this.segment];
    if (!seg) return;
    this.goalAlt = this.alt;

    let useInterceptPitch = false;
    let interceptPitch = 0;
    const world = this.world;

    switch (seg.guidMode) {
      case GM_NAV: {
        this.goalHeading = bearing(this, this.waypoint);
        this.rangeToObjective_km = groundRange_m(this, this.waypoint) / 1000;
        if (seg.altMode === AM_DATUM) {
          interceptPitch = interceptData3D(this, { ...this.waypoint, heading: 0, pitch: 0, speed_kts: 0 }).pitch;
          useInterceptPitch = true;
        }
        break;
      }
      case GM_COMMAND: {
        const track = world.getTrack(this.side, this.intendedTarget);
        if (track) {
          interceptPitch = this.steerToward(predict(track, t), true);
          // command-only missiles (e.g. ESSM) fly the terminal phase on intercept pitch
          const terminal = this.segment === this.profile.length - 1 && this.interceptTime < TERMINAL_COMMAND_S;
          useInterceptPitch =
            terminal || seg.altMode === AM_INTERCEPT || (seg.altMode === AM_INTERCEPT_HIGH && interceptPitch > 0);
        } else if (this.interceptTime < 9990) {
          this.goalHeading = bearing(this, this.waypoint);
          this.rangeToObjective_km = groundRange_m(this, this.waypoint) / 1000;
        } else {
          return world.removeMissile(this, "lost command track, self-destructed");
        }
        if (this.fcRadar && (!this.fcRadar.active || this.fcRadar.parent.dead)) {
          return world.removeMissile(this, "lost fire-control radar, self-destructed");
        }
        break;
      }
      case GM_SENSOR: {
        if (!this.seeker) break;
        if (!this.seeker.active) {
          this.seeker.active = true;
          this.seekerMode = this.seekerTargetId != null ? "acquire" : "search";
        }
        this.guidanceInterval = 0.5;
        if (this.seekerMode === "track" && this.seekerSnap) {
          interceptPitch = this.steerToward(predict(this.seekerSnap, t), true);
          // keep the target inside 90% of the seeker's half field of view
          const lim = 0.9 * 0.5 * this.seeker.db.fov_deg * DEG;
          const dh = wrapPi(this.goalHeading - this.heading);
          if (dh > lim) this.goalHeading = wrap2Pi(this.heading + lim);
          else if (dh < -lim) this.goalHeading = wrap2Pi(this.heading - lim);
          if (this.alt <= 4 && interceptPitch < 0) interceptPitch = 0;
          useInterceptPitch =
            seg.altMode === AM_INTERCEPT || (seg.altMode === AM_INTERCEPT_HIGH && interceptPitch > 0);
        } else if (this.fcRadar) {
          // not yet acquired: fly toward the ship's fire-control track
          const track = world.getTrack(this.side, this.intendedTarget);
          if (track) {
            interceptPitch = this.steerToward(predict(track, t), true);
            useInterceptPitch = true;
          }
        }
        break;
      }
      default:
        break;
    }

    // mid-flight malfunction check
    if (!this.malfunctionChecked && this.distanceFromLaunch / 1000 > this.rangeToObjective_km) {
      this.malfunctionChecked = true;
      if (world.rng.next() > this.db.probNoFaults) return world.removeMissile(this, "malfunctioned");
    }

    if (this.interceptTime <= 2) {
      this.guidanceInterval = 0.1;
      this.seekerScanPeriod = 0.1;
    } else if (this.interceptTime <= 5) {
      this.guidanceInterval = 0.2;
      this.seekerScanPeriod = 0.2;
    }

    switch (seg.altMode) {
      case AM_ASL:
      case AM_ASL_LOFT:
      case AM_AGL: // all-ocean map: AGL == ASL
        // negative values are intentional: with the soft altitude hold they force steeper
        // dives in weave profiles (e.g. SS-N-22), and the next segment pulls the missile up
        this.goalAlt = seg.alt_m;
        break;
      case AM_DATUM:
        useInterceptPitch = true;
        break;
      default:
        break;
    }

    if (useInterceptPitch) {
      this.goalPitch = interceptPitch;
      this.goalAlt = IGNORE_ALT;
    } else {
      this.goalPitch = 0;
    }

    // advance to the next flight-profile segment
    if (this.segment < this.profile.length - 1 && this.rangeToObjective_km < seg.range_km) {
      this.segment++;
      const next = this.profile[this.segment];
      if (next.guidMode === GM_SENSOR && this.seeker && !this.seeker.active) {
        this.seeker.active = true;
        this.seekerMode = this.seekerTargetId != null ? "acquire" : "search";
      }
    }
  }

  snapshot(target, t) {
    return {
      kind: target.kind, className: target.db.name,
      lat: target.lat, lon: target.lon, alt: target.alt, heading: target.heading,
      pitch: target.pitch || 0, speed_kts: target.speed_kts, t,
    };
  }

  /** Seeker scan: search / acquire / track state machine. */
  updateSeeker(t) {
    const s = this.seeker;
    if (!s || !s.active) return;
    const period = Math.min(s.db.scanPeriod_s || 0.5, this.seekerScanPeriod || 0.5);
    if (t - s.lastScan < period) return;
    s.lastScan = t;
    const world = this.world;

    if (this.seekerMode === "track" || this.seekerMode === "acquire") {
      const target = world.get(this.seekerTargetId);
      if (target && !target.dead && s.canDetect(target, false)) {
        this.seekerMode = "track";
        this.seekerSnap = this.snapshot(target, t);
        return;
      }
      // coast on the last track through brief dropouts (e.g. pitch manoeuvres taking the
      // target outside the seeker cone) instead of dropping straight back to search
      if (this.seekerMode === "track" && target && !target.dead && t - this.seekerSnap.t < SEEKER_COAST_S) return;
      if (this.seekerMode === "track") {
        this.seekerMode = "search";
        this.seekerSnap = null;
        if (!target || target.dead) this.seekerTargetId = null;
      }
      if (this.seekerMode === "acquire" && (!target || target.dead)) {
        this.seekerMode = "search";
        this.seekerTargetId = null;
      }
      if (this.seekerMode === "acquire") return;
    }

    // search: lock the intended target if visible, otherwise the nearest visible enemy
    let best = null;
    let bestRange = Infinity;
    for (const o of world.objects.values()) {
      if (o.side === this.side || o.dead || !this.canEngage(o)) continue;
      if (!s.canDetect(o, false)) continue;
      const r = o.id === this.intendedTarget ? -1 : range3D_m(this, o);
      if (r < bestRange) {
        best = o;
        bestRange = r;
      }
    }
    if (best) {
      this.seekerMode = "track";
      this.seekerTargetId = best.id;
      this.intendedTarget = best.id;
      this.seekerSnap = this.snapshot(best, t);
    }
  }

  canEngage(o) {
    const f = this.db.targetFlags;
    if (o.kind === "ship") return (f & 1) !== 0;
    if (o.kind === "missile") return (f & 8) !== 0 || (f & 2) !== 0;
    return false;
  }

  /** Port of UpdateDetonation: direct-hit collision, proximity fuze, and closest-approach fuzing. */
  updateDetonation(dt) {
    if (this.interceptTime > 3) return;
    const last = this.segment === this.profile.length - 1;
    let targetId = null;
    if (this.seekerMode === "track") targetId = this.seekerTargetId;
    else if (last && this.profile[this.segment].guidMode === GM_COMMAND) targetId = this.intendedTarget;
    if (targetId == null) return;
    const target = this.world.get(targetId);
    if (!target || target.dead) return;

    const detR = this.db.detonationRange_m;
    const cpa = closestApproach(this, target);
    // closest approach anywhere in the step just flown or the next one
    const inWindow = cpa.t >= -dt && cpa.t <= dt;
    // GCB2 delays detonation to the closest-approach point (Detonate(dt)); we record the miss
    // distance there so damage uses it instead of the missile's position at this time step
    const burst = (range_m, direct) => {
      this.burst = { targetId: target.id, range_m };
      return this.world.detonate(this, direct ? target : null);
    };

    // direct-hit test against the target's box
    if (target.kind === "ship") {
      const rel = inWindow ? { x: -cpa.dx, y: -cpa.dy, z: -cpa.dz } : negate(enu(this, target));
      if (insideShip(rel, target)) return burst(0, detR === 0);
    } else if (inWindow && cpa.miss_m <= 2) {
      return burst(cpa.miss_m, detR === 0);
    }
    if (detR === 0) return;

    const range_m = range3D_m(this, target);
    if (range_m <= detR) return burst(range_m, false);
    if (inWindow && cpa.miss_m <= detR) return burst(cpa.miss_m, false);
  }
}

function negate(v) {
  return { x: -v.x, y: -v.y, z: -v.z };
}

/** Is a point (missile relative to ship, east/north/up metres) inside the ship's hull box? */
function insideShip(rel, ship) {
  const h = ship.heading;
  const along = rel.x * Math.sin(h) + rel.y * Math.cos(h);
  const across = rel.x * Math.cos(h) - rel.y * Math.sin(h);
  const height = 2 * (ship.db.effectiveHeight_m || 10);
  return (
    Math.abs(along) <= 0.5 * ship.db.length_m &&
    Math.abs(across) <= 0.5 * Math.max(ship.db.beam_m, 8) &&
    rel.z <= height &&
    rel.z >= -ship.db.draft_m
  );
}
