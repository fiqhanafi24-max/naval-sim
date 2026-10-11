// Simulation world: object registry, per-side track picture, launches, detonations and a
// simple computer opponent. No DOM access, so it can run headless (tests, a future server).

import { Atmosphere } from "./atmosphere.js";
import { calculateDamage, applyDamage } from "./damage.js";
import { DEG, bearing, groundRange_m, offset, range3D_m, wrapPi } from "./geo.js";
import { Missile, predict } from "./missile.js";
import { Random } from "./random.js";
import { Ship } from "./ship.js";

export const SIDES = ["blue", "red"];
const STALE_S = { ship: 120, missile: 10 };
const AI_INTERVAL_S = 1;
const MAX_SAMS_PER_THREAT = 2;

// targetFlags bits from GCB2 tcWeaponDBObject.h
const SURFACE_TARGET = 0x1, AIR_TARGET = 0x2, MISSILE_TARGET = 0x8;

/** Dedicated anti-ship missile (dual-role SAMs like ESSM can hit ships but are kept for air defence). */
export function isAntiShip(db) {
  return (db.targetFlags & SURFACE_TARGET) !== 0 && (db.targetFlags & (AIR_TARGET | MISSILE_TARGET)) === 0;
}

export function isAntiAir(db) {
  return (db.targetFlags & (AIR_TARGET | MISSILE_TARGET)) !== 0;
}

export class World {
  /**
   * @param {object} data exported GCB2 units (data/gcb-units.json)
   * @param {string} atmosphereCsv contents of data/atmosphere.csv
   * @param {object} scenario scenario JSON
   */
  constructor(data, atmosphereCsv, scenario) {
    this.data = data;
    this.atmosphere = new Atmosphere(atmosphereCsv);
    this.scenario = scenario;
    this.rng = new Random(scenario.seed ?? 1);
    this.t = 0;
    this.nextId = 1;
    this.objects = new Map();
    this.wrecks = [];
    this.tracks = { blue: new Map(), red: new Map() };
    this.events = [];
    this.detonations = [];
    this.salvos = [];
    this.lastSalvoAt = new Map(); // `${side}:${targetId}` -> time
    this.nextAi = 0;
    this.intel = {};
    this.ai = scenario.ai || {};
    this.over = null;

    for (const u of scenario.units) {
      const db = data.ships[u.class];
      if (!db) throw new Error(`Unknown ship class in scenario: ${u.class}`);
      this.add(new Ship(this, db, u));
    }
    for (const side of SIDES) {
      const cfg = scenario.intel?.[side];
      if (cfg) this.intel[side] = { ...cfg, next: cfg.firstAt_s ?? 0 };
    }
  }

  add(o) {
    this.objects.set(o.id, o);
    return o;
  }

  get(id) {
    return this.objects.get(id);
  }

  ships(side) {
    return [...this.objects.values()].filter((o) => o.kind === "ship" && !o.dead && (!side || o.side === side));
  }

  missiles() {
    return [...this.objects.values()].filter((o) => o.kind === "missile" && !o.dead);
  }

  enemy(side) {
    return side === "blue" ? "red" : "blue";
  }

  log(side, text, kind = "info") {
    this.events.push({ t: this.t, side, text, kind });
    if (this.events.length > 500) this.events.shift();
  }

  getTrack(side, id) {
    return this.tracks[side].get(id);
  }

  // ---------------------------------------------------------------- main loop

  step(dt) {
    this.t += dt;
    const t = this.t;

    for (const o of [...this.objects.values()]) {
      if (o.dead) continue;
      if (o.kind === "ship") o.update(dt);
      else o.update(dt, t);
    }

    for (const o of this.objects.values()) {
      if (o.kind === "missile" && !o.dead && t - (o.lastTrail || -1e9) >= 1) {
        o.lastTrail = t;
        o.trail.push({ lat: o.lat, lon: o.lon, alt: o.alt });
        if (o.trail.length > 400) o.trail.shift();
      }
    }

    this.updateSensors(t);
    this.updateIntel(t);
    this.expireTracks(t);

    if (t >= this.nextAi) {
      this.nextAi = t + AI_INTERVAL_S;
      for (const side of SIDES) this.runAi(side);
    }
    this.runSalvos();
    this.detonations = this.detonations.filter((d) => t - d.t < 3);
    this.checkEnd();
  }

  updateSensors(t) {
    for (const ship of this.ships()) {
      for (const radar of ship.radars) {
        if (!radar.active || t - radar.lastScan < radar.db.scanPeriod_s) continue;
        radar.lastScan = t;
        for (const o of this.objects.values()) {
          if (o.dead || o.side === ship.side) continue;
          if (radar.canDetect(o, true)) this.updateTrack(ship.side, o, radar.db.name, 0, this.measure(radar, o));
        }
      }
    }
  }

  /**
   * Fixed per-platform, per-sensor bias in [-1, 1] that varies with target bearing
   * (tcSensorState::GetErrorFactor).
   */
  errorFactor(platformId, sensorKey, az) {
    if (!this.errorTable) {
      this.errorTable = Float32Array.from({ length: 4096 }, () => 2 * this.rng.next() - 1);
    }
    const w = Math.sin(2 * az) ** 2;
    const i1 = ((platformId << 4) + (sensorKey & 0xf)) & 0xfff;
    const i2 = (i1 + 1) & 0xfff;
    return w * this.errorTable[i1] + (1 - w) * this.errorTable[i2];
  }

  /** Radar position report with range and bearing bias (tcSensorState::UpdateActiveReport). */
  measure(radar, o) {
    const p = radar.parent;
    const key = radar.key ?? (radar.key = [...radar.db.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
    const az = bearing(p, o);
    const slant_m = range3D_m(p, o) + radar.db.rangeError * this.errorFactor(p.id + 100, key, az);
    const dalt = o.alt - p.alt;
    const ground_m = Math.sqrt(Math.max(slant_m * slant_m - dalt * dalt, 0));
    const azEst = az + radar.db.angleError_deg * DEG * this.errorFactor(p.id, key, az);
    return { pos: offset(p, azEst, ground_m), angleError_deg: radar.db.angleError_deg };
  }

  /**
   * @param {number} error_m intel report position error (random), 0 for sensor tracks
   * @param {{pos, angleError_deg}} [measured] sensor report from measure()
   */
  updateTrack(side, o, source, error_m = 0, measured = null) {
    const tracks = this.tracks[side];
    const existing = tracks.get(o.id);
    let pos = measured ? measured.pos : { lat: o.lat, lon: o.lon, alt: o.alt };
    if (error_m > 0) {
      pos = offset(pos, this.rng.next() * 2 * Math.PI, Math.abs(this.rng.gaussian()) * error_m);
    }
    // a sensor track is better than an intel report; don't overwrite a fresh one with intel
    if (existing && error_m > 0 && existing.error_m === 0 && this.t - existing.t < 30) return;
    // simple fusion: keep a recent report from a more accurate radar
    const quality = measured ? measured.angleError_deg : Infinity;
    if (existing && existing.quality < quality && this.t - existing.t < 5) return;
    // intel tracks last until the next report is due; sensor tracks go stale quickly
    const intel = this.intel[side];
    const life_s = error_m > 0 && intel ? intel.interval_s * 1.2 : STALE_S[o.kind];
    const track = {
      id: o.id, kind: o.kind, className: o.db.name, side: o.side,
      lat: pos.lat, lon: pos.lon, alt: o.alt, heading: o.heading, pitch: o.pitch || 0,
      speed_kts: o.speed_kts, t: this.t, expires: this.t + life_s, source, error_m, quality,
      firstSeen: existing ? existing.firstSeen : this.t,
    };
    tracks.set(o.id, track);
    if (o.kind === "missile") {
      track.announced = existing?.announced || false;
      if (!track.announced && this.threatens(side, track)) {
        track.announced = true;
        this.log(side, `Inbound missile detected (${source})`, "threat");
      }
    } else if (!existing) {
      this.log(side, `New contact: ${o.db.name} (${source})`, "contact");
    }
  }

  updateIntel(t) {
    for (const side of SIDES) {
      const cfg = this.intel[side];
      if (!cfg || t < cfg.next) continue;
      cfg.next = t + cfg.interval_s;
      const enemies = this.ships(this.enemy(side));
      for (const o of enemies) this.updateTrack(side, o, cfg.source || "intel report", cfg.error_m);
      if (enemies.length) this.log(side, `${cfg.source || "Intel report"}: ${enemies.length} surface contacts`, "contact");
    }
  }

  expireTracks(t) {
    for (const side of SIDES) {
      for (const [id, tr] of this.tracks[side]) {
        const o = this.get(id);
        if (!o || o.dead || t > tr.expires) this.tracks[side].delete(id);
      }
    }
  }

  // ---------------------------------------------------------------- weapons

  /**
   * Launch one missile.
   * @returns {{ok: boolean, reason?: string, missile?: Missile}}
   */
  launch(ship, launcherIdx, targetId) {
    const L = ship.launchers[launcherIdx];
    if (!L || ship.dead) return { ok: false, reason: "no launcher" };
    if (L.count <= 0) return { ok: false, reason: "out of ammunition" };
    if (this.t - L.arm.lastFire < L.cycle_s) return { ok: false, reason: "launcher reloading" };
    const track = this.getTrack(ship.side, targetId);
    if (!track) return { ok: false, reason: "no track" };
    const db = this.data.missiles[L.item];
    const target = this.get(targetId);
    if (!target || target.dead) return { ok: false, reason: "target gone" };

    const datum = predict(track, this.t);
    const range_km = groundRange_m(ship, datum) / 1000;
    if (range_km > db.maxRange_km) return { ok: false, reason: "out of range" };
    if (range_km < db.minRange_km) return { ok: false, reason: "too close" };

    let fcRadar = null;
    if (db.needsFireControl) {
      fcRadar = L.fc;
      if (!fcRadar || !fcRadar.active) return { ok: false, reason: "no fire-control radar" };
      if (!fcRadar.canDetect(target, false)) return { ok: false, reason: "fire-control radar has no lock" };
      if (!fcRadar.requestTrack(targetId)) return { ok: false, reason: "no fire-control channel free" };
    }

    const m = new Missile(this, db, { shooter: ship, launcher: L, targetId, datum, fcRadar });
    this.add(m);
    L.count--;
    L.arm.lastFire = this.t;
    return { ok: true, missile: m };
  }

  removeMissile(m, reason) {
    if (m.dead) return;
    m.dead = true;
    this.objects.delete(m.id);
    if (m.fcRadar) m.fcRadar.releaseTrack(m.intendedTarget);
    for (const side of SIDES) this.tracks[side].delete(m.id);
    if (reason) this.log(m.side, `${m.name} ${reason}`, "miss");
  }

  detonate(m, directTarget) {
    const wh = this.data.warheads[m.db.damageModel];
    const good = this.rng.next() <= (wh ? wh.probDetonate : 1);
    m.directHitTargetId = directTarget ? directTarget.id : null;
    this.detonations.push({ t: this.t, lat: m.lat, lon: m.lon, alt: m.alt, big: isAntiShip(m.db) });

    const radius_m = Math.max(wh ? wh.maxRange_m : 0, 50);
    for (const o of [...this.objects.values()]) {
      if (o === m || o.dead) continue;
      if (o !== directTarget && range3D_m(m, o) > radius_m) continue;
      const res = applyDamage(o, calculateDamage(m, o, good, this), this);
      if (res.newDamage <= 0) continue;
      if (o.kind === "ship") {
        this.log(m.side, `${m.name} hit ${o.name}: +${Math.round(res.newDamage * 100)}% damage (${res.code})`, "hit");
        this.log(o.side, `${o.name} hit by ${m.db.name}: ${Math.round(o.damage * 100)}% damaged`, "damage");
      } else if (o.damage < 1 && o.side !== m.side) {
        this.log(m.side, `${m.name} damaged ${o.db.name} (${Math.round(o.damage * 100)}%) but it is still flying`, "miss");
      }
      if (o.damage >= 1) this.destroy(o, m);
    }
    this.removeMissile(m, null);
    if (!good) this.log(m.side, `${m.name} warhead failed to detonate`, "miss");
  }

  destroy(o, by) {
    if (o.kind === "missile") {
      if (by && by.side !== o.side) this.log(by.side, `${by.db.name} intercepted ${o.db.name}`, "kill");
      this.removeMissile(o, null);
      return;
    }
    o.dead = true;
    o.speed_kts = 0;
    for (const r of o.radars) r.active = false;
    for (const side of SIDES) this.tracks[side].delete(o.id);
    this.log(o.side, `${o.name} has been sunk`, "lost");
    if (by) this.log(by.side, `${o.name} sunk`, "kill");
  }

  /** Launcher indices holding anti-ship missiles that can reach range_km. */
  antiShipLaunchers(ship, range_km = 0) {
    return ship.launchers
      .map((l, i) => i)
      .filter((i) => {
        const L = ship.launchers[i];
        const db = this.data.missiles[L.item];
        return isAntiShip(db) && L.count > 0 && db.maxRange_km >= range_km;
      });
  }

  /** Queue a salvo of anti-ship missiles from one ship at a track. */
  orderSalvo(ship, targetId, count) {
    const track = this.getTrack(ship.side, targetId);
    if (!track) return { ok: false, reason: "no track" };
    if (!this.antiShipLaunchers(ship).length) return { ok: false, reason: "no anti-ship missiles left" };
    const idxs = this.antiShipLaunchers(ship, groundRange_m(ship, predict(track, this.t)) / 1000);
    if (!idxs.length) return { ok: false, reason: "target out of range" };
    this.salvos.push({ shipId: ship.id, targetId, remaining: count, launchers: idxs, fired: 0 });
    this.lastSalvoAt.set(`${ship.side}:${targetId}`, this.t);
    return { ok: true };
  }

  /**
   * Every ship on a side that can reach the target fires `perShip` anti-ship missiles at it,
   * so the missiles arrive together and saturate the target's fire-control channels.
   * @param {number} rangeFactor fraction of maximum range a shooter must be inside
   */
  orderGroupSalvo(side, targetId, perShip, rangeFactor = 1) {
    const track = this.getTrack(side, targetId);
    if (!track) return { ok: false, reason: "no track" };
    const datum = predict(track, this.t);
    const busy = new Set(this.salvos.map((s) => s.shipId));
    const shooters = this.ships(side).filter(
      (s) => !busy.has(s.id) && this.antiShipLaunchers(s, groundRange_m(s, datum) / 1000 / rangeFactor).length,
    );
    if (!shooters.length) return { ok: false, reason: "no ship has anti-ship missiles in range" };
    for (const s of shooters) this.orderSalvo(s, targetId, perShip);
    return { ok: true, ships: shooters.length };
  }

  runSalvos() {
    for (const s of this.salvos) {
      const ship = this.get(s.shipId);
      if (!ship || ship.dead) {
        s.remaining = 0;
        continue;
      }
      for (const i of s.launchers) {
        if (s.remaining <= 0) break;
        const res = this.launch(ship, i, s.targetId);
        if (res.ok) {
          s.remaining--;
          s.fired++;
        } else if (!["launcher reloading", "out of ammunition"].includes(res.reason)) {
          this.log(ship.side, `${ship.name}: salvo stopped, ${res.reason}`, "info");
          s.remaining = 0;
        }
      }
      if (s.remaining > 0 && s.launchers.every((i) => ship.launchers[i].count <= 0)) s.remaining = 0;
      if (s.remaining <= 0 && s.fired) {
        const tr = this.getTrack(ship.side, s.targetId);
        this.log(ship.side, `${ship.name} fired ${s.fired} x ${ship.launchers[s.launchers[0]].item} at ${tr ? tr.className : "target"}`, "launch");
      }
    }
    this.salvos = this.salvos.filter((s) => s.remaining > 0);
  }

  // ---------------------------------------------------------------- computer opponent

  runAi(side) {
    const cfg = this.ai[side] || {};
    if (cfg.autoDefend !== false) this.airDefense(side);
    if (cfg.weaponsFree) this.offense(side, cfg.salvo || 4);
  }

  /** Is a missile (position + heading) flying toward one of this side's ships? */
  threatens(side, m) {
    return this.ships(side).some(
      (s) => Math.abs(wrapPi(bearing(m, s) - m.heading)) < 30 * DEG && groundRange_m(m, s) < 150000,
    );
  }

  /** Engage inbound missile tracks with SAMs, up to two in the air per threat. */
  airDefense(side) {
    const own = this.ships(side);
    if (!own.length) return;
    const sams = this.missiles().filter((m) => m.side === side && isAntiAir(m.db));
    for (const tr of this.tracks[side].values()) {
      if (tr.kind !== "missile") continue;
      const threat = predict(tr, this.t);
      if (!this.threatens(side, threat)) continue;
      let inFlight = sams.filter((m) => m.intendedTarget === tr.id).length;
      const shooters = [...own].sort((a, b) => groundRange_m(a, threat) - groundRange_m(b, threat));
      for (const ship of shooters) {
        if (inFlight >= MAX_SAMS_PER_THREAT) break;
        const order = ship.launchers
          .map((l, i) => i)
          .filter((i) => {
            const db = this.data.missiles[ship.launchers[i].item];
            return isAntiAir(db) && ship.launchers[i].count > 0;
          })
          // longest-ranged weapon that can reach first
          .sort((a, b) => this.data.missiles[ship.launchers[b].item].maxRange_km - this.data.missiles[ship.launchers[a].item].maxRange_km);
        for (const i of order) {
          const db = this.data.missiles[ship.launchers[i].item];
          if (groundRange_m(ship, threat) / 1000 > 0.9 * db.maxRange_km) continue;
          const res = this.launch(ship, i, tr.id);
          if (res.ok) {
            inFlight++;
            this.log(side, `${ship.name} engaging inbound missile with ${db.name}`, "launch");
            break;
          }
        }
      }
    }
  }

  /**
   * Coordinated anti-ship attack on the largest enemy ship in reach. Waits until every ship
   * carrying anti-ship missiles is in range, unless one is already well inside its range.
   */
  offense(side, salvoSize) {
    if (this.salvos.some((s) => this.get(s.shipId)?.side === side)) return;
    const carriers = this.ships(side).filter((s) => this.antiShipLaunchers(s).length);
    if (!carriers.length) return;
    const targets = [...this.tracks[side].values()]
      .filter((tr) => tr.kind === "ship" && this.t - (this.lastSalvoAt.get(`${side}:${tr.id}`) ?? -1e9) >= 600)
      .sort((a, b) => (this.data.ships[b.className]?.length_m || 0) - (this.data.ships[a.className]?.length_m || 0));
    for (const tr of targets) {
      const datum = predict(tr, this.t);
      const inRange = (s, f) => this.antiShipLaunchers(s, groundRange_m(s, datum) / 1000 / f).length > 0;
      const allReady = carriers.every((s) => inRange(s, 0.9));
      const anyClose = carriers.some((s) => inRange(s, 0.6));
      if (!allReady && !anyClose) continue;
      const res = this.orderGroupSalvo(side, tr.id, salvoSize, 0.9);
      if (res.ok) return;
    }
  }

  checkEnd() {
    if (this.over) return;
    for (const side of SIDES) {
      if (this.ships(side).length === 0) {
        this.over = { loser: side, t: this.t };
        this.log(side, `All ${side} ships lost. Scenario over.`, "lost");
        this.log(this.enemy(side), `All ${side} ships sunk. Scenario over.`, "kill");
      }
    }
  }
}
