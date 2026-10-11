// Seeded random numbers so a scenario replays identically for a given seed.

export class Random {
  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }

  /** Uniform [0, 1) — mulberry32. */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal (Box-Muller). */
  gaussian() {
    const u = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Poisson sample (port of randfn.cpp Poisson). */
  poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 8) return Math.floor(lambda);
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p >= L);
    return k - 1;
  }
}
