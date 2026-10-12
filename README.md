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

## Scenarios

Pick one from the briefing screen, or open `?scenario=<id>`.

| Id | Scenario |
|---|---|
| `norwegian-sea` | Norwegian Sea, 2008: US surface action group, P-3C and F/A-18 strike against Sovremenny and Udaloy destroyers, Il-38 and Tu-22M raid |
| `falklands-1982` | Falklands, 4 May 1982: defend a Type 42/Type 22 picket line against Super Étendards with Exocets |
| `sidra-1986` | Gulf of Sidra, 24 March 1986: Yorktown and Caron, with A-6E strikes, against Libyan Nanuchka corvettes |

Scenario files are plain JSON in `scenarios/`; add new ones to `scenarios/index.json`.

## What's simulated

Ported from GCB2, with deviations noted at the top of each source file:

- Radar detection: horizon, signal margin, aspect-dependent RCS, sea clutter, blind speed,
  probabilistic detection, fixed per-radar range/bearing bias
- Infrared and optical seekers
- Missile flight (thrust, Mach-dependent drag), flight profiles, command / inertial / seeker
  guidance, semi-active homing, proximity and contact fuzing
- Close-in weapon bursts, deck guns on ballistic trajectories, magazines and reload times
- Blast, fragmentation, penetration and kinetic damage for ships, aircraft and missiles
- Patrol and strike aircraft; tracks that go stale and age out

## Layout

| Path | What it is |
|---|---|
| `src/sim/` | Simulation engine, no DOM. Runs headless. |
| `src/sim/radar.js` | Radar detection (port of `tcRadar.cpp`) |
| `src/sim/optical.js` | IR and optical seekers (port of `tcOpticalSensor.cpp`) |
| `src/sim/missile.js` | Missile flight, guidance, seeker, fuzing (port of `tcMissileObject.cpp`, `tcAero.cpp`) |
| `src/sim/ballistic.js` | Guns and close-in weapons (port of `tcBallisticWeapon.cpp`) |
| `src/sim/damage.js` | Weapon effects (port of `tcDamageModel.cpp`) |
| `src/sim/aircraft.js` | Patrol and strike aircraft |
| `src/sim/world.js` | Tracks, launches, detonations, computer opponent |
| `src/ui/app.js` | CesiumJS globe and control panels |
| `src/ui/models.js`, `src/ui/effects.js` | Generated 3D models (ships, aircraft, missiles), explosions, smoke |
| `models.html`, `src/ui/gallery.js` | Model gallery: every catalogue unit's 3D model |
| `data/gcb-units.json` | Unit data exported from the GCB2 database |
| `scenarios/` | Scenario files |
| `tools/export_gcb_db.py` | Re-exports unit data from GCB2's `database.db` |
| `tests/headless.html` | Physics and scenario checks |

## Adding ships, aircraft and weapons

Edit the `SHIPS` or `AIRCRAFT` list in `tools/export_gcb_db.py` (class name plus a platform setup
from GCB2's `platform_setup` table), then rerun:

```bash
python3 -I tools/export_gcb_db.py path/to/gcblue/database/database.db data/gcb-units.json
```

## Not ported yet

Fighters and air-to-air combat, torpedoes and submarines, sonar, helicopters, ESM/ECM and
jamming, chaff and decoys, terrain and land, day/night, multiplayer.

## Licence

BSD-3-Clause. Contains code and data derived from GCB2, copyright (c) 2014 gcblue, also
BSD-3-Clause; see `NOTICE`.
