"""Export a subset of the GCB2 SQLite database to JSON for the browser sim.

Usage: python3 -I tools/export_gcb_db.py <path/to/database.db> <out.json>

Pulls the listed ship classes (with the chosen platform setup), their radar
fit, missile launchers + loadouts, and everything those missiles reference
(seeker radars, warhead data, damage-effect tables, RCS signature models).

Source data: GCB2 database, Copyright (c) 2014 gcblue, BSD-3-Clause.
"""
import json
import os
import sqlite3
import sys

# python3 -I leaves the script's folder off sys.path; custom_units.py lives beside this file
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from custom_units import CUSTOM_SHIPS  # noqa: E402

# (ship class, platform setup name)
SHIPS = [
    ("Arleigh Burke DDGHM", "Burke 2008"),
    ("Ticonderoga CG Baseline 4", "Tico B4 2008"),
    ("Oliver Hazard Perry FFGHM", "Oliver Hazard Perry 2008"),
    ("Pr 956 Sarych", "Pr 956 2007"),
    ("Pr 1155 Fregat", "Pr 1155 2007"),
    # Falklands, 1982
    ("Type 42 DDG Batch 1", "Type 42 B1 1982"),
    ("Type 22 FF Batch 1", "Type 22 B1 1982"),
    # Gulf of Sidra, 1986
    ("Ticonderoga CG Baseline 1", "Tico B1 1984"),
    ("Spruance DDG", "Spruance 1984"),
    ("Pr 1234E Ovod-E (Libya)", "Pr 1234 Ovod-1"),
]

# (aircraft class, GCB table: "simpleair" for props/patrol, "air" for jets, setup name or None)
AIRCRAFT = [
    ("P-3C III Orion", "simpleair", None),
    ("Il-38", "simpleair", None),
    ("F/A-18E", "air", "SM1   2010"),
    ("Tu-22ME", "air", None),
    ("Super Etendard M", "air", "SM1E  1979"),
    ("A-6E", "air", "SM1   1979"),
]

# Tu-22M3 anti-ship load: GCB2 has the launchers but no setup with Kh-22s
AIRCRAFT_LOADOUTS = {
    "Tu-22ME": {"0": [("Kh-22M", 2)], "1": [("Kh-22M", 1)]},
    # Argentine strikes in 1982 carried one Exocet and a drop tank
    "Super Etendard M": {"2": []},
}

# Corrections to GCB2 flight profiles: {missile: {segment index: fields}}
PROFILE_FIXES = {
    # AM-39 is active-radar homing like the MM-38, whose last segment uses its seeker;
    # GCB2 stores 0 (command) here, which would steer it on the launching side's track
    "AM-39 Exocet": {2: {"guidMode": 2}},
}

# Magazine contents per launcher id, replacing the setup's loadout. GCB models each Mk-41
# cell (and the Mk-13 arm) as a launcher reloaded from a magazine; we flatten that to one
# launcher holding counts of one or more weapon types that share its reload cycle.
MAGAZINE_OVERRIDES = {
    "Arleigh Burke DDGHM": {"0": [("RIM-66M", 32)], "1": [("RIM-162A", 24)], "2": None},
    # two 61-cell Mk-41s; the remaining cells hold Tomahawks, which aren't ported yet
    "Ticonderoga CG Baseline 4": {"0": [("RIM-66M", 60)], "1": [("RIM-162A", 32)], "2": None},
    # Mk-13 single-arm launcher fed from a 40-round magazine (36 SM-1MR + 4 Harpoon)
    "Oliver Hazard Perry FFGHM": {"2": [("RIM-66L", 36), ("RGM-84F Harpoon", 4)]},
    # Phalanx was fitted to Type 42s only after the Falklands
    "Type 42 DDG Batch 1": {"0": None, "1": None},
    # the Libyan Nanuchka II's setup leaves its SS-N-2C launchers empty
    "Pr 1234E Ovod-E (Libya)": {"0": [("P-15M Termit", 2)], "1": [("P-15M Termit", 2)]},
}


def rows(db, sql, *args):
    cur = db.execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def one(db, sql, *args):
    r = rows(db, sql, *args)
    return r[0] if r else None


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def parse_effect(s):
    """'0 0; 1.5 0; 2 0.1' -> [[0,0],[1.5,0],[2,0.1]] (tcDamageEffect::ParseEffectString)."""
    pts = []
    for part in (s or "").split(";"):
        bits = part.split()
        if len(bits) == 2:
            pts.append([float(bits[0]), float(bits[1])])
    return pts


def export_radar(db, name):
    r = one(db, "select * from radar where DatabaseClass=?", name)
    if not r:
        return None
    return {
        "name": name,
        "refRange_km": num(r["RefRange_km"]),
        "maxRange_km": num(r["MaxRange_km"]),
        "fov_deg": num(r["FieldOfView_deg"], 360),
        "minEl_deg": num(r["MinElevation_deg"], -90),
        "maxEl_deg": num(r["MaxElevation_deg"], 90),
        "scanPeriod_s": num(r["ScanPeriod_s"], 4),
        "isSemiactive": bool(int(num(r["IsSemiactive"]))),
        "isSurveillance": bool(int(num(r["IsSurveillance"]))),
        "maxFireControlTracks": int(num(r["MaxFireControlTracks"])),
        "blindSpeed_mps": num(r["BlindSpeed_mps"]),
        "lookdownWater_dB": num(r["LookdownWater_dB"]),
        "lookdownLand_dB": num(r["LookdownLand_dB"]),
        "elBeamwidth_deg": num(r["ElevationBeamwidth_deg"], 2),
        "rangeError": num(r["RangeError"]),
        "angleError_deg": num(r["AngleError_deg"]),
        "detectsSurface": bool(int(num(r["DetectsSurface"]))),
        "detectsAir": bool(int(num(r["DetectsAir"]))),
        "detectsMissile": bool(int(num(r["DetectsMissile"]))),
        "detectsGround": bool(int(num(r["DetectsGround"]))),
    }


def export_signature(db, name, out):
    if not name or name in out:
        return
    s = one(db, "select * from signature where DatabaseClass=?", name)
    if s:
        out[name] = [num(s["Aspect%d" % a]) for a in range(0, 190, 10)]


def export_optical(db, name):
    o = one(db, "select * from optical where DatabaseClass=?", name)
    if not o:
        return None
    return {
        "name": name,
        "refRange_km": num(o["RefRange_km"]),
        "maxRange_km": num(o["MaxRange_km"]),
        "fov_deg": num(o["FieldOfView_deg"], 360),
        "scanPeriod_s": num(o["ScanPeriod_s"], 1),
        "isIR": bool(int(num(o["IsIR"]))),
        "isSurveillance": bool(int(num(o["IsSurveillance"]))),
        "detectsSurface": bool(int(num(o["DetectsSurface"]))),
        "detectsAir": bool(int(num(o["DetectsAir"]))),
        "detectsMissile": bool(int(num(o["DetectsMissile"]))),
        "nightFactor": num(o["NightFactor"], 1),
    }


def ir_fields(r):
    """IR and optical signature columns shared by ships, aircraft and missiles."""
    return {
        "irSignature_dB": num(r["IRSignature_dB"]),
        "irModel": r["IR_ModelA"] or None,
        "opticalCrossSection_dBsm": num(r["OpticalCrossSection_dBsm"]),
    }


def export_missile(db, name, data):
    if name in data["missiles"]:
        return True
    m = one(db, "select * from missile where DatabaseClass=?", name)
    if not m:
        return False
    # a segment counts only if its range or altitude is positive (tcMissileDBObject::ReadSql)
    profile = []
    for i in range(1, 9):
        if not (num(m["Rng%d_km" % i]) > 0 or num(m["Alt%d_m" % i]) > 0):
            continue
        g = m["GuidMode%d" % i]
        profile.append({
            "range_km": num(m["Rng%d_km" % i]),
            "alt_m": num(m["Alt%d_m" % i]),
            "altMode": int(num(m["AltMode%d" % i])),
            "guidMode": int(num(g)),
        })
    for idx, fix in PROFILE_FIXES.get(name, {}).items():
        profile[idx].update(fix)
    seeker = m["SensorClass"] or None
    seeker_type = None
    if seeker:
        if seeker in data["radars"] or export_radar(db, seeker):
            data["radars"].setdefault(seeker, export_radar(db, seeker))
            seeker_type = "radar"
        elif seeker in data["opticals"] or export_optical(db, seeker):
            data["opticals"].setdefault(seeker, export_optical(db, seeker))
            seeker_type = "optical"
        else:
            seeker = None  # ESM / anti-radiation seekers not ported yet
    export_signature(db, m["RCS_Model"], data["signatures"])
    export_signature(db, m["IR_ModelA"], data["signatures"])
    data["missiles"][name] = {
        "name": name,
        "weight_kg": num(m["Weight_kg"]),
        "launchSpeed_mps": num(m["LaunchSpeed_mps"]),
        "minRange_km": num(m["MinRange_km"]),
        "maxRange_km": num(m["MaxRange_km"]),
        "targetFlags": int(num(m["targetFlags"])),
        "probNoFaults": num(m["ProbNoFaults"], 1),
        "detonationRange_m": num(m["DetonationRange_m"]),
        "rcs_dBsm": num(m["RCS_dBsm"]),
        "rcsModel": m["RCS_Model"] or None,
        **ir_fields(m),
        "effectiveHeight_m": num(m["EffectiveHeight_m"]),
        "gMax": num(m["Gmax"]),
        "maxTurnRate_degps": num(m["MaxTurnRate_degps"]),
        "cdpsub": num(m["Cdpsub"]), "cdptran": num(m["Cdptran"]), "cdpsup": num(m["Cdpsup"]),
        "mcm": num(m["Mcm"]), "msupm": num(m["Msupm"]),
        "boostThrust_N": num(m["BoostThrust_N"]), "boostTime_s": num(m["BoostTime_s"]),
        "sustThrust_N": num(m["SustThrust_N"]), "sustTime_s": num(m["SustTime_s"]),
        "shutdownSpeed_mps": num(m["ShutdownSpeed_mps"]),
        "seeker": seeker,
        "seekerType": seeker_type,
        "needsFireControl": bool(int(num(m["NeedsFireControl"]))),
        "damageModel": m["DamageModel"],
        "damageEffect": m["DamageEffect"],
        "profile": profile,
    }
    export_warhead(db, m["DamageModel"], data)
    export_damage_effect(db, m["DamageEffect"], data)
    return True


def export_warhead(db, name, data):
    if not name or name in data["warheads"]:
        return
    wd = one(db, "select * from weapon_damage where DatabaseClass=?", name)
    if wd:
        data["warheads"][name] = {
            "maxRange_m": num(wd["MaxRange_m"]),
            "probDetonate": num(wd["ProbDetonate"], 1),
            "isPenetration": bool(int(num(wd["IsPenetration"]))),
            "blastCharge_kg": num(wd["BlastCharge_kg"]),
            "fragCharge_kg": num(wd["FragCharge_kg"]),
            "radCharge_kg": num(wd["RadCharge_kg"]),
            "fragMetal_kg": num(wd["FragMetal_kg"]),
            "fragFragment_kg": num(wd["FragFragment_kg"]),
            "fragSpread": num(wd["FragSpread"], 1),
        }


GUN_ROUND, AUTO_CANNON = 0, 2


def export_gun(db, name, data):
    """Gun rounds and autocannon bursts (tcBallisticDBObject types 0 and 2)."""
    if name in data["guns"]:
        return True
    b = one(db, "select * from ballistic where DatabaseClass=?", name)
    if not b or int(num(b["BallisticType"], -1)) not in (GUN_ROUND, AUTO_CANNON):
        return False
    data["guns"][name] = {
        "name": name,
        "type": "autocannon" if int(num(b["BallisticType"])) == AUTO_CANNON else "gun",
        "weight_kg": num(b["Weight_kg"]),
        "launchSpeed_mps": num(b["LaunchSpeed_mps"]),
        "minRange_km": num(b["MinRange_km"]),
        "maxRange_km": num(b["MaxRange_km"], 20) or 20,
        "angleError_rad": num(b["AngleError_rad"]),
        "burstCount": int(num(b["BurstCount"])),
        "targetFlags": int(num(b["targetFlags"])),
        "detonationRange_m": num(b["DetonationRange_m"]),
        "probNoFaults": num(b["ProbNoFaults"], 1),
        "damageModel": b["DamageModel"],
        "damageEffect": b["DamageEffect"],
    }
    export_warhead(db, b["DamageModel"], data)
    return True


def export_damage_effect(db, name, data):
    if not name or name in data["damageEffects"]:
        return
    d = one(db, "select * from damage_effect where DatabaseClass=?", name)
    if d:
        data["damageEffects"][name] = {
            "blast": parse_effect(d["BlastEffect"]),
            "waterBlast": parse_effect(d["WaterBlastEffect"]),
            "frag": parse_effect(d["FragEffect"]),
            "rad": parse_effect(d["RadEffect"]),
            "internal": parse_effect(d["InternalEffect"]),
        }


def export_launcher(db, data, sensors, pl, item, keep=None):
    """One launcher entry for (launcher row, (item, quantity)), or None if the weapon isn't ported.

    pl needs LauncherId, LauncherClass, Description, FiringArc_deg, Az, El, FireControlSensor.
    """
    if export_gun(db, item[0], data):
        kind = "gun"
    elif export_missile(db, item[0], data):
        kind = "missile"
        if any(seg["guidMode"] == 3 for seg in data["missiles"][item[0]]["profile"]):
            return None  # payload-deploying weapons (e.g. ASW rockets): not ported yet
    else:
        return None  # torpedoes, empty cells: not ported yet
    if keep and not keep(kind, item[0]):
        return None
    fc = pl["FireControlSensor"] or None
    if fc and fc not in data["radars"]:
        fc = None
    if fc is None and kind == "missile" and data["missiles"][item[0]]["needsFireControl"]:
        # fall back to the first fire-control radar on the platform
        fc = next((x["name"] for x in sensors
                   if data["radars"][x["name"]]["maxFireControlTracks"] > 0), None)
    # time between shots: single-round launchers (Mk-13, VLS cells) reload from the
    # magazine before every shot; multi-round launchers just cycle
    lc = one(db, "select * from launcher_configuration where DatabaseClass=? and ChildClass=?",
             pl["LauncherClass"], item[0])
    cycle_s, capacity, load_s = 2.0, item[1], 0.0
    if lc:
        cycle_s = num(lc["CycleTime_s"], 2)
        capacity = int(num(lc["ChildCapacity"], 1))
        load_s = num(lc["LoadTime_s"])
        if capacity == 1:
            cycle_s += load_s
    return {
        "id": int(pl["LauncherId"]),  # entries with the same id share one launcher arm
        "kind": kind,
        "description": pl["Description"],
        "item": item[0], "count": item[1], "cycle_s": round(cycle_s, 2),
        "capacity": capacity, "reload_s": load_s,
        "firingArc_deg": num(pl["FiringArc_deg"]), "az_deg": num(pl["Az"]),
        "el_deg": num(pl["El"]),
        "fireControl": fc,
    }


def export_fit(db, cls, loadout, data, keep=None):
    """Radars and weapon launchers fitted to a ship or aircraft class.

    keep(kind, item_name) can drop weapons that aren't wanted for that platform.
    """
    sensors = []
    for ps in rows(db, "select * from platform_sensor where DatabaseClass=?", cls):
        rad = export_radar(db, ps["SensorClass"])
        if rad:
            data["radars"][rad["name"]] = rad
            sensors.append({"name": rad["name"], "mountAz_deg": num(ps["SensorAz"])})

    launchers = []
    for pl in rows(db, "select * from platform_launcher where DatabaseClass=? order by LauncherId", cls):
        for item in loadout.get(str(pl["LauncherId"])) or []:
            entry = export_launcher(db, data, sensors, pl, item, keep)
            if entry:
                launchers.append(entry)

    return sensors, launchers


def setup_loadout(db, setup):
    return {str(r["LauncherId"]): [(r["Item"], int(r["Quantity"]))]
            for r in rows(db, "select * from launcher_loadout where DatabaseClass=?", setup["LauncherLoadout"])}


def export_ship(db, data, cls, setup_name):
    s = one(db, "select * from ship where DatabaseClass=?", cls)
    setup = one(db, "select * from platform_setup where DatabaseClass=? and SetupName=?", cls, setup_name)
    loadout = setup_loadout(db, setup)
    loadout.update(MAGAZINE_OVERRIDES.get(cls, {}))

    sensors, launchers = export_fit(db, cls, loadout, data)

    # ammunition below decks, used to reload launchers and gun mounts; skipped for
    # launchers whose totals are set in MAGAZINE_OVERRIDES so nothing is counted twice
    overridden = set(MAGAZINE_OVERRIDES.get(cls, {}))
    reload_items = {l["item"] for l in launchers if str(l["id"]) not in overridden}
    magazine = {}
    for r in rows(db, "select * from magazine_loadout where DatabaseClass=?", setup["MagazineLoadout"]):
        if r["Item"] in reload_items:
            magazine[r["Item"]] = magazine.get(r["Item"], 0) + int(num(r["Quantity"]))

    export_signature(db, s["RCS_Model"], data["signatures"])
    export_signature(db, s["IR_ModelA"], data["signatures"])
    export_damage_effect(db, s["DamageEffect"], data)
    data["ships"][cls] = {
        "name": cls, "country": s["Country"], "setup": setup_name, "year": int(num(setup["InitialYear"])),
        "maxSpeed_kts": num(s["MaxSpeed_kts"]), "accel_ktsps": num(s["Accel_ktsps"], 0.5),
        "turnRate_degps": num(s["TurnRate_degps"], 3),
        "length_m": num(s["Length_m"]), "beam_m": num(s["Beam_m"]), "draft_m": num(s["Draft_m"]),
        "rcs_dBsm": num(s["RCS_dBsm"]), "rcsModel": s["RCS_Model"] or None, **ir_fields(s),
        "effectiveHeight_m": num(s["EffectiveHeight_m"]),
        "damageEffect": s["DamageEffect"],
        "sensors": sensors, "launchers": launchers, "magazine": magazine,
    }


def export_aircraft(db, data, cls, table, setup_name):
    a = one(db, "select * from %s where DatabaseClass=?" % table, cls)
    loadout = {}
    year = None
    if setup_name:
        setup = one(db, "select * from platform_setup where DatabaseClass=? and SetupName=?", cls, setup_name)
        loadout = setup_loadout(db, setup)
        year = int(num(setup["InitialYear"]))
    loadout.update(AIRCRAFT_LOADOUTS.get(cls, {}))
    # anti-ship missiles only: air-to-air weapons and aircraft guns aren't ported yet
    sensors, launchers = export_fit(
        db, cls, loadout, data,
        keep=lambda kind, item: kind == "missile" and data["missiles"][item]["targetFlags"] == 1)
    export_signature(db, a["RCS_Model"], data["signatures"])
    export_signature(db, a["IR_ModelA"], data["signatures"])
    export_damage_effect(db, a["DamageEffect"], data)
    max_kts = num(a["MaxSpeed_kts"])
    data["aircraft"][cls] = {
        "name": cls, "country": a["Country"], "setup": setup_name, "year": year,
        "role": "strike" if launchers else "patrol",
        "maxSpeed_kts": max_kts,
        # GCB2 jets fly an aero model; we use a fixed cruise speed instead
        "cruiseSpeed_kts": round(max_kts * (0.55 if table == "air" else 0.8)),
        "accel_ktsps": num(a["Accel_ktsps"], 5), "turnRate_degps": num(a["TurnRate_degps"], 5),
        "maxAlt_m": num(a["MaxAltitude_m"], 10000), "climbRate_mps": num(a["ClimbRate_mps"], 15),
        "fuel_kg": num(a["FuelCapacity_kg"]), "fuelRate_kgps": num(a["FuelRate_kgps"]),
        "rcs_dBsm": num(a["RCS_dBsm"]), "rcsModel": a["RCS_Model"] or None, **ir_fields(a),
        "effectiveHeight_m": num(a["EffectiveHeight_m"]) or 3,
        "length_m": 20,
        "damageEffect": a["DamageEffect"],
        "sensors": sensors, "launchers": launchers,
    }


def latest_setup(db, cls):
    r = one(db, "select SetupName from platform_setup where DatabaseClass=? "
                "order by InitialYear desc, SetupName desc limit 1", cls)
    return r["SetupName"] if r else None


def best_strike_setup(db, cls):
    """The setup carrying the most anti-ship missiles (newest first on ties), or None."""
    best, best_n = None, 0
    for st in rows(db, "select * from platform_setup where DatabaseClass=? order by InitialYear desc", cls):
        n = 0
        for r in rows(db, "select * from launcher_loadout where DatabaseClass=?", st["LauncherLoadout"]):
            m = one(db, "select targetFlags from missile where DatabaseClass=?", r["Item"])
            if m and int(num(m["targetFlags"])) == 1:
                n += int(num(r["Quantity"]))
        if n > best_n:
            best, best_n = st["SetupName"], n
    return best


def has_search_radar(db, cls):
    for ps in rows(db, "select * from platform_sensor where DatabaseClass=?", cls):
        r = one(db, "select DetectsSurface from radar where DatabaseClass=?", ps["SensorClass"])
        if r and int(num(r["DetectsSurface"])):
            return True
    return False


def export_custom_ship(db, data, cls, spec):
    """A ship class built from GCB2 components (tools/custom_units.py)."""
    base = one(db, "select * from ship where DatabaseClass=?", spec["base"])
    sensors = []
    for name in spec["sensors"]:
        rad = export_radar(db, name)
        if not rad:
            raise ValueError("%s: unknown GCB2 radar %r" % (cls, name))
        data["radars"][name] = rad
        sensors.append({"name": name, "mountAz_deg": 0})
    launchers = []
    for i, (lclass, item, count, arc, az, fc, desc) in enumerate(spec["launchers"]):
        pl = {"LauncherId": i, "LauncherClass": lclass, "Description": desc, "FiringArc_deg": arc,
              "Az": az, "El": 40 if "Exocet" in lclass else 0, "FireControlSensor": fc}
        entry = export_launcher(db, data, sensors, pl, (item, count))
        if not entry:
            raise ValueError("%s: GCB2 weapon %r is not usable" % (cls, item))
        launchers.append(entry)
    export_signature(db, base["RCS_Model"], data["signatures"])
    export_signature(db, base["IR_ModelA"], data["signatures"])
    export_damage_effect(db, base["DamageEffect"], data)
    hull = spec["hull"]
    data["ships"][cls] = {
        "name": cls, "country": spec["country"], "setup": "custom", "year": spec["year"], "note": spec["note"],
        "maxSpeed_kts": hull["maxSpeed_kts"], "accel_ktsps": num(base["Accel_ktsps"], 0.5),
        "turnRate_degps": num(base["TurnRate_degps"], 3),
        "length_m": hull["length_m"], "beam_m": hull["beam_m"], "draft_m": hull["draft_m"],
        "rcs_dBsm": num(base["RCS_dBsm"]), "rcsModel": base["RCS_Model"] or None, **ir_fields(base),
        "effectiveHeight_m": num(base["EffectiveHeight_m"]),
        "damageEffect": base["DamageEffect"],
        "sensors": sensors, "launchers": launchers, "magazine": dict(spec.get("magazine", {})),
    }


def main(db_path, out_path):
    db = sqlite3.connect(db_path)
    db.text_factory = lambda b: b.decode("utf-8", errors="replace")
    data = {"source": "GCB2 database (c) 2014 gcblue, BSD-3-Clause",
            "ships": {}, "aircraft": {}, "radars": {}, "opticals": {}, "missiles": {}, "guns": {}, "warheads": {},
            "damageEffects": {}, "signatures": {}}

    # hand-picked classes used by the built-in scenarios
    for cls, setup_name in SHIPS:
        export_ship(db, data, cls, setup_name)
    for cls, table, setup_name in AIRCRAFT:
        export_aircraft(db, data, cls, table, setup_name)
    # classes GCB2 doesn't have, built from its components (tools/custom_units.py)
    for cls, spec in CUSTOM_SHIPS.items():
        export_custom_ship(db, data, cls, spec)

    # full catalogue for the scenario editor: every other class, latest setup for ships;
    # strike aircraft with their heaviest anti-ship load, and patrol aircraft with a surface radar
    skipped = []
    for r in rows(db, "select DatabaseClass from ship order by DatabaseClass"):
        cls = r["DatabaseClass"]
        if cls in data["ships"]:
            continue
        setup_name = latest_setup(db, cls)
        if not setup_name:
            continue
        try:
            export_ship(db, data, cls, setup_name)
        except Exception as e:  # incomplete database rows: skip the class, report it
            skipped.append("%s (%s)" % (cls, e))
    for table in ("air", "simpleair"):
        for r in rows(db, "select DatabaseClass from %s order by DatabaseClass" % table):
            cls = r["DatabaseClass"]
            if cls in data["aircraft"]:
                continue
            try:
                setup_name = best_strike_setup(db, cls)
                if setup_name or has_search_radar(db, cls):
                    export_aircraft(db, data, cls, table, setup_name)
            except Exception as e:
                skipped.append("%s (%s)" % (cls, e))

    with open(out_path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    for k in ("ships", "aircraft", "radars", "opticals", "missiles", "guns", "warheads", "damageEffects", "signatures"):
        print("%-14s %d" % (k, len(data[k])))
    if skipped:
        print("skipped %d classes with incomplete data:" % len(skipped))
        for s in skipped:
            print("  " + s)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
