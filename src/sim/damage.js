// Weapon effects, ported from GCB2 src/sim/tcDamageModel.cpp (blast, fragmentation, thermal,
// direct-hit kinetic + internal) and tcPlatformObject::ApplyAdvancedDamage. Underwater blast
// and cluster munitions are not ported yet.

import { range3D_m } from "./geo.js";

/** Blast overpressure in PSI at range for a charge of w_kg TNT-equivalent. */
export function blastOverpressure(range_m, w_kg) {
  if (w_kg <= 0 || range_m <= 0) return 0;
  const scaled = range_m * Math.pow(1.1e-6 * w_kg, -0.333);
  return 3.25e6 * Math.pow(scaled, -2.3) + 4800 * Math.pow(scaled + 305, -1.2);
}

/** Thermal intensity in J/cm2. */
export function radiationIntensity(range_m, w_kg) {
  if (w_kg <= 0) return 0;
  return (w_kg * 2.7e2) / (4 * Math.PI * range_m * range_m);
}

/** Fragment hits on a target (Gurney velocity, aero drag, spherical spread, Poisson hits). */
export function fragmentImpact(range_m, alt_m, wh, targetArea_m2, atmosphere, rng) {
  const deltaE = 2.7e6;
  const Kshape = 0.5;
  const fragDensity = 8000;
  const gurney = Math.sqrt(2 * deltaE);
  const rho = atmosphere.density(Math.max(alt_m, 0));
  const nFrag = wh.fragMetal_kg / wh.fragFragment_kg;
  const aFrag = Math.pow((1.3293 * wh.fragFragment_kg) / fragDensity, 0.667);
  const cToM = wh.fragCharge_kg / wh.fragMetal_kg;
  const v0 = gurney * Math.sqrt(cToM / (1 + Kshape * cToM));
  const v = v0 * Math.exp((-rho * 0.5 * aFrag * range_m) / (2 * wh.fragFragment_kg));
  const avgHits = targetArea_m2 * (nFrag / (wh.fragSpread * 4 * Math.PI * range_m * range_m));
  return { hits: Math.min(rng.poisson(avgHits), 50), ke_J: 0.5 * wh.fragFragment_kg * v * v };
}

/** Piecewise-linear damage-factor lookup (tcDamageEffect::GetDamageFactor). */
export function damageFactor(table, level) {
  if (!table || table.length === 0 || level <= 0) return 0;
  if (level <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (level >= last[0]) return last[1];
  for (let i = 0; i < table.length - 1; i++) {
    const [l0, f0] = table[i];
    const [l1, f1] = table[i + 1];
    if (level > l0 && level <= l1) {
      if (l1 <= l0) return f0;
      const alpha = (l1 - level) / (l1 - l0);
      return alpha * f0 + (1 - alpha) * f1;
    }
  }
  return 0;
}

export function targetSpan_m(target) {
  return target.kind === "ship" ? target.db.length_m : 3;
}

/**
 * Damage inputs from a detonation on one target (tcDamageModel::CalculateTotalDamage).
 * @param {boolean} goodDetonation warhead functioned
 */
export function calculateDamage(weapon, target, goodDetonation, world) {
  const wh = world.data.warheads[weapon.db.damageModel];
  const dmg = { kinetic_J: 0, explosive_kg: 0, isPenetration: false, blast_psi: 0, thermal_J_cm2: 0, fragHits: 0, fragEnergy_J: 0 };
  if (!wh) return dmg;

  if (weapon.directHitTargetId === target.id) {
    const closing = Math.max(weapon.closingSpeed_mps(target), 0);
    dmg.kinetic_J = 0.5 * weapon.db.weight_kg * closing * closing;
    dmg.isPenetration = wh.isPenetration;
    dmg.explosive_kg = goodDetonation ? wh.blastCharge_kg + wh.fragCharge_kg + wh.fragMetal_kg : 0;
    return dmg;
  }
  if (weapon.directHitTargetId != null || !goodDetonation) return dmg;
  if (target.alt < -3) return dmg; // surface blast does not reach submerged targets

  // use the fuzed miss distance for the target the weapon homed on
  let range_m = weapon.burst?.targetId === target.id ? weapon.burst.range_m : range3D_m(weapon, target);
  const span = targetSpan_m(target);
  const minRange_m = Math.max(Math.min(0.05 * span, 50), 5);
  range_m = Math.max(range_m, minRange_m);

  dmg.blast_psi = blastOverpressure(range_m, wh.blastCharge_kg);
  dmg.thermal_J_cm2 = radiationIntensity(range_m, wh.radCharge_kg);

  if (wh.fragCharge_kg > 0 && wh.fragFragment_kg > 0) {
    const r = 0.5 * span;
    const area = 0.5 * Math.PI * r * r;
    const f = fragmentImpact(Math.max(range_m, r), target.alt, wh, area, world.atmosphere, world.rng);
    dmg.fragHits = f.hits;
    dmg.fragEnergy_J = f.ke_J;
  }
  return dmg;
}

/**
 * Apply damage to a platform (tcPlatformObject::ApplyAdvancedDamage) or a weapon
 * (tcWeaponObject::ApplyAdvancedDamage, which scales fragment hits and randomness differently).
 * @returns {{newDamage: number, code: string}} code letters: K kinetic, X internal, B blast, T thermal, F frag
 */
export function applyDamage(target, dmg, world) {
  if (target.damage >= 1) return { newDamage: 0, code: "" };
  const eff = world.data.damageEffects[target.db.damageEffect];
  if (!eff) return { newDamage: 0, code: "" };
  const isWeapon = target.kind === "missile";

  const impact = damageFactor(eff.frag, dmg.kinetic_J);
  const internalThreshold = isWeapon ? 0.02 : 0.002;
  const internal = dmg.isPenetration && impact > internalThreshold ? damageFactor(eff.internal, dmg.explosive_kg) : 0;
  const blast = damageFactor(eff.blast, dmg.blast_psi);
  const thermal = damageFactor(eff.rad, dmg.thermal_J_cm2);
  const hitsFactor = isWeapon ? Math.sqrt(dmg.fragHits) : 1 + Math.log10(Math.max(dmg.fragHits, 1));
  const frag = dmg.fragHits > 0 ? hitsFactor * damageFactor(eff.frag, dmg.fragEnergy_J) : 0;

  const total = impact + internal + blast + thermal + frag;
  if (total <= 0) return { newDamage: 0, code: "" };

  let code = "";
  if (impact > 0) code += "K";
  if (internal > 0) code += "X";
  if (blast > 0) code += "B";
  if (thermal > 0) code += "T";
  if (frag > 0) code += "F";

  // platforms: median about 0.5, minimum 0.05; weapons: uniform 70-130% (both as in GCB2)
  const r = isWeapon ? 0.7 + 0.6 * world.rng.next() : 0.642 * Math.abs(world.rng.gaussian()) + 0.05;
  const newDamage = Math.min(r * total, 1 - target.damage);
  target.damage = Math.min(target.damage + r * total, 1);
  return { newDamage, code };
}
