# Open Naval Sim

A browser-based naval warfare simulator with a 3D globe, built on the simulation models of
[Global Conflicts Blue 2](https://github.com/WarfareCode/gcblue) (GCB2), translated from C++ to
JavaScript.

## Run it

Browsers block ES modules opened from `file://`, so serve the folder locally:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8765/> for the game, or <http://127.0.0.1:8765/tests/headless.html>
for the simulation checks. An internet connection is needed for CesiumJS and the map imagery
(loaded from the jsDelivr CDN).

## Layout

| Path | What it is |
|---|---|
| `src/sim/` | Simulation engine, no DOM. Runs headless. |
| `src/sim/radar.js` | Radar detection (port of `tcRadar.cpp`) |
| `src/sim/missile.js` | Missile flight, guidance, seeker, fuzing (port of `tcMissileObject.cpp`, `tcAero.cpp`) |
| `src/sim/damage.js` | Blast, fragmentation and penetration damage (port of `tcDamageModel.cpp`) |
| `src/sim/world.js` | Tracks, launches, detonations, computer opponent |
| `src/ui/app.js` | CesiumJS globe and control panels |
| `data/gcb-units.json` | Unit data exported from the GCB2 database |
| `scenarios/` | Scenario files |
| `tools/export_gcb_db.py` | Re-exports unit data from GCB2's `database.db` |
| `tests/headless.html` | Physics and scenario checks |

## Adding ships and weapons

Edit the `SHIPS` list in `tools/export_gcb_db.py` (class name plus a platform setup from GCB2's
`platform_setup` table), then rerun:

```bash
python3 -I tools/export_gcb_db.py path/to/gcblue/database/database.db data/gcb-units.json
```

## Not ported yet

Guns and CIWS, torpedoes and submarines, sonar, aircraft and helicopters, ESM/ECM and jamming,
IR seekers, terrain and land, multiplayer.

## Licence

BSD-3-Clause. Contains code and data derived from GCB2, copyright (c) 2014 gcblue, also
BSD-3-Clause; see `NOTICE`.
