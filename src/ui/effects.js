// Visual effects: explosion bursts, smoke from damaged ships, ship wakes.
// Particles run in real time (not sim time) so they look right at any time compression.
/* global Cesium */

let puffImage = null;
/** Soft round particle texture, drawn once on a canvas. */
function puff() {
  if (puffImage) return puffImage;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.5)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  puffImage = c;
  return c;
}

export class Effects {
  constructor(viewer) {
    this.scene = viewer.scene;
    this.bursts = []; // {system, until}
    this.smoke = new Map(); // shipId -> ParticleSystem
  }

  /** One-shot fireball and debris cloud. @param {boolean} big ship hit vs missile intercept */
  explosion(position, big) {
    const size = big ? 30 : 10;
    const system = new Cesium.ParticleSystem({
      image: puff(),
      startColor: Cesium.Color.fromCssColorString("#ffcc66").withAlpha(0.95),
      endColor: Cesium.Color.fromCssColorString("#333333").withAlpha(0),
      startScale: 1,
      endScale: big ? 5 : 3,
      minimumParticleLife: 0.8,
      maximumParticleLife: big ? 3 : 1.5,
      minimumSpeed: big ? 10 : 20,
      maximumSpeed: big ? 40 : 60,
      imageSize: new Cesium.Cartesian2(size, size),
      sizeInMeters: true,
      emissionRate: 0,
      bursts: [new Cesium.ParticleBurst({ time: 0, minimum: big ? 40 : 15, maximum: big ? 60 : 25 })],
      lifetime: 0.5,
      loop: false,
      emitter: new Cesium.SphereEmitter(big ? 8 : 2),
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(position),
    });
    this.scene.primitives.add(system);
    this.bursts.push({ system, until: performance.now() + 4000 });
  }

  /** Keep a smoke column over each damaged ship; heavier as damage grows. */
  shipSmoke(ship, position) {
    let system = this.smoke.get(ship.id);
    if (ship.damage < 0.15 || !position) {
      if (system) {
        this.scene.primitives.remove(system);
        this.smoke.delete(ship.id);
      }
      return;
    }
    if (!system) {
      system = new Cesium.ParticleSystem({
        image: puff(),
        startColor: Cesium.Color.fromCssColorString("#2b2b2b").withAlpha(0.7),
        endColor: Cesium.Color.fromCssColorString("#777777").withAlpha(0),
        startScale: 1,
        endScale: 6,
        minimumParticleLife: 6,
        maximumParticleLife: 12,
        minimumSpeed: 4,
        maximumSpeed: 8,
        imageSize: new Cesium.Cartesian2(25, 25),
        sizeInMeters: true,
        emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(15)),
      });
      this.scene.primitives.add(system);
      this.smoke.set(ship.id, system);
    }
    system.emissionRate = 2 + 10 * ship.damage;
    system.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  }

  /** Remove finished bursts and smoke for ships no longer shown. */
  tidy(visibleShipIds) {
    const now = performance.now();
    this.bursts = this.bursts.filter((b) => {
      if (now < b.until) return true;
      this.scene.primitives.remove(b.system);
      return false;
    });
    for (const [id, system] of this.smoke) {
      if (!visibleShipIds.has(id)) {
        this.scene.primitives.remove(system);
        this.smoke.delete(id);
      }
    }
  }
}
