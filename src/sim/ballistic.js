// Gun rounds and close-in-weapon bursts, ported from GCB2 src/sim/tcBallisticWeapon.cpp
// (LaunchFrom, Update, UpdateAutocannon, UpdateTargetFuse), tcBallisticDBObject::GetGunneryElevation
// and tcSimState::EvaluateBallisticDamage.
//
// Differences from GCB2:
//  - autocannon hits are counted against a circle of TARGET_RADIUS_M around the target instead
//    of ray-casting its 3D mesh;
//  - ship hits by gun rounds use the hull box (as missiles do) instead of the mesh.

import {
  DEG, MPS_TO_KTS, G_MPS2, advance, bearing, closestApproach, groundRange_m,
  interceptData3D, range3D_m, velocity, wrapPi,
} from "./geo.js";

const TARGET_RADIUS_M = { missile: 0.4, ship: 10 };
const AUTOCANNON_CHECK_M = 500;
const MAX_ALONG_TRACK_ERROR_M = 50;
const TARGET_WIDTH_GUESS_M = 20;

let roundCounter = 0;

/** Uniform in [-a, a] (GCB2 randfc). */
function randc(rng, a) {
  return a * (2 * rng.next() - 1);
}

/**
 * Low-angle gun elevation for a target at range_m and height difference dz_m, vacuum trajectory
 * (tcBallisticDBObject::GetGunneryElevation, small-dz branch).
 * @returns {{el: number, tti_s: number}}
 */
export function gunneryElevation(launchSpeed, range_m, dz_m) {
  const solve = (r) => {
    const b = -launchSpeed * launchSpeed;
    const fac = r * r * G_MPS2 * G_MPS2;
    if (b * b < fac) return null;
    const vz = Math.sqrt(0.5 * (-b - Math.sqrt(b * b - fac)));
    return { el: Math.asin(vz / launchSpeed), tti_s: (2 / G_MPS2) * vz, vz };
  };
  let s = solve(range_m);
  if (!s) return { el: 0.25 * Math.PI, tti_s: 0 };
  if (Math.abs(dz_m) >= 2) {
    // coarse correction for a height difference
    const r2 = range_m + (dz_m / s.vz) * launchSpeed * Math.cos(s.el);
    s = solve(r2) || s;
  }
  return { el: s.el, tti_s: s.tti_s };
}

export class Round {
  /**
   * @param {object} world
   * @param {object} db gun database record (data.guns)
   * @param {object} o {shooter, launcher, target}
   */
  constructor(world, db, { shooter, launcher, target }) {
    this.world = world;
    this.db = db;
    this.kind = "round";
    this.id = world.nextId++;
    this.name = `${db.name} #${++roundCounter}`;
    this.label = launcher.description || db.name;
    this.side = shooter.side;
    this.dead = false;
    this.damage = 0;
    this.intendedTarget = target.id;
    this.lat = shooter.lat;
    this.lon = shooter.lon;
    this.alt = shooter.alt + 10;
    this.distance_m = 0;
    this.trail = [];

    const rng = world.rng;
    const v = db.launchSpeed_mps;
    this.speed_kts = v * MPS_TO_KTS;
    if (db.type === "autocannon") {
      // aim at the truth intercept point, as GCB2 does
      const ic = interceptData3D(this, target);
      this.heading = ic.heading + randc(rng, db.angleError_rad);
      this.pitch = ic.pitch + randc(rng, db.angleError_rad);
    } else {
      // iterate the gun solution against the predicted target position (CalculateGunSolution)
      let aim = { lat: target.lat, lon: target.lon, alt: target.alt };
      let sol = { el: 0, tti_s: 0 };
      for (let i = 0; i < 4; i++) {
        sol = gunneryElevation(v, groundRange_m(this, aim), aim.alt - this.alt);
        const vt = velocity(target);
        aim = { lat: target.lat, lon: target.lon, alt: target.alt + vt.z * sol.tti_s };
        advance(aim, Math.hypot(vt.x, vt.y) * sol.tti_s, target.heading);
      }
      this.heading = bearing(this, aim) + randc(rng, db.angleError_rad);
      this.pitch = sol.el + randc(rng, db.angleError_rad);
    }
    this.vxy = v * Math.cos(this.pitch);
    this.vz = v * Math.sin(this.pitch);
  }

  update(dt) {
    const vzPrev = this.vz;
    if (this.db.type === "gun") this.vz -= G_MPS2 * dt;
    const d = this.vxy * dt;
    advance(this, d, this.heading);
    this.alt += 0.5 * (this.vz + vzPrev) * dt;
    this.pitch = Math.atan2(this.vz, this.vxy);
    this.speed_kts = Math.hypot(this.vxy, this.vz) * MPS_TO_KTS;
    this.distance_m += this.db.type === "autocannon" ? Math.hypot(this.vxy, this.vz) * dt : d;

    if (this.db.type === "autocannon") this.updateAutocannon(dt);
    else this.updateTargetFuse(dt);
    if (this.dead) return;
    if (this.distance_m > 1000 * this.db.maxRange_km || this.alt < -1) this.world.removeRound(this);
  }

  /** Burst passes its closest approach to the target: count hits (EvaluateBallisticDamage). */
  updateAutocannon(dt) {
    const target = this.world.get(this.intendedTarget);
    if (!target || target.dead) return;
    if (range3D_m(this, target) > AUTOCANNON_CHECK_M) return;
    const cpa = closestApproach(this, target);
    if (cpa.t > dt) return;

    this.dead = true; // burst is spent either way
    const hits = this.countHits(target, cpa);
    if (hits > 0) {
      const wh = this.world.data.warheads[this.db.damageModel];
      const rel = Math.hypot(...Object.values(relVelocity(this, target)));
      const dmg = {
        isPenetration: true,
        kinetic_J: 0.5 * this.db.weight_kg * rel * rel,
        fragHits: hits > 1 ? hits - 1 : 0,
        fragEnergy_J: hits > 1 ? 0.5 * this.db.weight_kg * rel * rel : 0,
        explosive_kg: wh && this.world.rng.next() < wh.probDetonate ? hits * wh.blastCharge_kg : 0,
        blast_psi: 0, thermal_J_cm2: 0,
      };
      this.world.applyRoundDamage(this, target, dmg);
    }
    this.world.removeRound(this);
  }

  /** Per-round Gaussian scatter around the burst axis; a round hits if it passes within the target radius. */
  countHits(target, cpa) {
    const dist = this.distance_m + cpa.t * this.db.launchSpeed_mps;
    const spread = dist * this.db.angleError_rad;
    // target offset from the burst axis at closest approach, in the plane across the line of fire
    const miss = { x: cpa.dx, y: cpa.dy, z: cpa.dz };
    const crossTrack = Math.hypot(miss.x, miss.y, miss.z);
    if (crossTrack > 4 * spread + TARGET_WIDTH_GUESS_M) return 0;
    const r = TARGET_RADIUS_M[target.kind] ?? 1;
    const rng = this.world.rng;
    let hits = 0;
    const n = Math.min(this.db.burstCount, 50);
    for (let i = 0; i < n; i++) {
      const err = Math.abs(spread * rng.gaussian());
      const ang = 2 * Math.PI * rng.next();
      // the round's offset is in a random direction across the line of fire; compare in 2D
      const dx = crossTrack - err * Math.cos(ang);
      const dy = err * Math.sin(ang);
      if (Math.hypot(dx, dy) <= r) hits++;
    }
    return this.db.burstCount > 50 ? Math.round(hits * this.db.burstCount / 50) : hits;
  }

  /** Gun round fuzing against its target (UpdateTargetFuse). */
  updateTargetFuse(dt) {
    const target = this.world.get(this.intendedTarget);
    if (!target || target.dead) return;
    const span = target.kind === "ship" ? target.db.length_m : 3;
    if (range3D_m(this, target) > Math.max(span, 100)) return;
    const cpa = closestApproach(this, target);
    const inWindow = cpa.t >= -dt && cpa.t <= dt;
    const detR = this.db.detonationRange_m;
    if (detR === 0) {
      if (target.kind === "ship" && inWindow && insideHull({ x: -cpa.dx, y: -cpa.dy, z: -cpa.dz }, target)) {
        this.burst = { targetId: target.id, range_m: 0 };
        return this.world.detonate(this, target);
      }
      return;
    }
    const range_m = range3D_m(this, target);
    if (range_m <= detR) {
      this.burst = { targetId: target.id, range_m };
      return this.world.detonate(this, null);
    }
    if (inWindow && cpa.miss_m <= detR) {
      this.burst = { targetId: target.id, range_m: cpa.miss_m };
      return this.world.detonate(this, null);
    }
  }

  closingSpeed_mps(target) {
    return Math.hypot(...Object.values(relVelocity(this, target)));
  }
}

function relVelocity(a, b) {
  const va = { x: a.vxy * Math.sin(a.heading), y: a.vxy * Math.cos(a.heading), z: a.vz };
  const vb = velocity(b);
  return { x: va.x - vb.x, y: va.y - vb.y, z: va.z - vb.z };
}

function insideHull(rel, ship) {
  const h = ship.heading;
  const along = rel.x * Math.sin(h) + rel.y * Math.cos(h);
  const across = rel.x * Math.cos(h) - rel.y * Math.sin(h);
  return (
    Math.abs(along) <= 0.5 * ship.db.length_m &&
    Math.abs(across) <= 0.5 * Math.max(ship.db.beam_m, 8) &&
    rel.z <= 2 * (ship.db.effectiveHeight_m || 10) &&
    rel.z >= -ship.db.draft_m
  );
}

/** Is the target inside this gun mount's firing arc? */
export function inFiringArc(ship, launcher, target) {
  if (launcher.firingArc_deg <= 0 || launcher.firingArc_deg >= 360) return true;
  const mount = ship.heading + launcher.az_deg * DEG;
  return Math.abs(wrapPi(bearing(ship, target) - mount)) <= 0.5 * launcher.firingArc_deg * DEG;
}
