// Standard atmosphere lookup (port of Aero::GetAirDensity / GetSoundSpeed).
// Table comes from GCB2's database/atmosphere.csv: alt [m], rho [kg/m3], c [m/s], T [K].

export class Atmosphere {
  /** @param {string} csv contents of atmosphere.csv */
  constructor(csv) {
    this.alt = [];
    this.rho = [];
    this.c = [];
    for (const line of csv.trim().split(/\r?\n/).slice(1)) {
      const [alt, rho, c] = line.split(",").map(Number);
      if (Number.isFinite(alt)) {
        this.alt.push(alt);
        this.rho.push(rho);
        this.c.push(c);
      }
    }
  }

  interp(table, alt_m) {
    const a = this.alt;
    if (alt_m <= a[0]) return table[0];
    const n = a.length - 1;
    if (alt_m >= a[n]) return table[n];
    // table has a uniform altitude step
    const step = a[1] - a[0];
    const i = Math.min(Math.floor((alt_m - a[0]) / step), n - 1);
    const alpha = (alt_m - a[i]) / (a[i + 1] - a[i]);
    return (1 - alpha) * table[i] + alpha * table[i + 1];
  }

  density(alt_m) {
    return this.interp(this.rho, alt_m);
  }

  soundSpeed(alt_m) {
    return this.interp(this.c, alt_m);
  }
}
