"""Ship classes that GCB2's database doesn't have, built from GCB2 components.

Only publicly published information is used. Each class borrows hull characteristics it has
no public data for (radar cross-section model, damage tables, handling) from a GCB2 ship of
similar size and type, and uses GCB2 sensors as stand-ins for the real ones. Values marked
"estimate" are not from any source.

Fields:
  base        GCB2 ship class whose hull data is borrowed
  hull        public dimensions and speed that override the base class
  sensors     GCB2 radar classes fitted (the real sensor in the comment)
  launchers   (launcher class, item, rounds ready, firing arc deg, mount azimuth deg,
               fire-control radar, description)
  magazine    reload rounds below decks
"""

# Royal Brunei Navy
# Sources: Wikipedia "Darussalam-class offshore patrol vessel", "Royal Brunei Navy",
# "KDB Ijtihad"; SeaForces "Ijtihad class FPB" (all public).
CUSTOM_SHIPS = {
    "Darussalam OPV": {
        "country": "Brunei",
        "year": 2011,
        "note": "KDB Darussalam (06), Darulehsan (07), Darulaman (08)",
        "base": "Famous Cutter WMEC",  # 82 m, 1,820 t US Coast Guard cutter: similar size
        "hull": {"length_m": 80, "beam_m": 13, "draft_m": 3.6, "maxSpeed_kts": 22},  # draft: estimate
        "sensors": [
            "Variant",       # stands in for the Terma Scanter 4100 air/surface search radar
            "9LV 200 FCS",   # stands in for the Thales Sting EO Mk2 fire-control director
        ],
        "launchers": [
            ("57 mm/70 (2.25in) Marks 2 - 3", "57mm PFHE", 120, 300, 0, "9LV 200 FCS", "Bofors 57 mm Mk3"),
            ("20mm/85  GAM-B01", "20mm/85  GAM-B01 HE-I", 50, 180, 90, None, "Stbd Oerlikon 20 mm"),
            ("20mm/85  GAM-B01", "20mm/85  GAM-B01 HE-I", 50, 180, 270, None, "Port Oerlikon 20 mm"),
            ("Exocet Quad Launcher", "MM-40 B3 Exocet", 4, 0, 0, None, "Exocet MM40 Block 3"),
        ],
        "magazine": {"57mm PFHE": 400, "20mm/85  GAM-B01 HE-I": 1000},  # estimate
    },
    "Darussalam OPV (Daruttaqwa)": {
        "country": "Brunei",
        "year": 2014,
        "note": "KDB Daruttaqwa (09): MLG 27 instead of the 57 mm gun, no Exocet",
        "base": "Famous Cutter WMEC",
        "hull": {"length_m": 80, "beam_m": 13, "draft_m": 3.6, "maxSpeed_kts": 22},
        "sensors": ["Variant", "9LV 200 FCS"],
        "launchers": [
            ("27mm MLG 27", "27mm DM10 FAPDS", 90, 300, 0, "9LV 200 FCS", "Rheinmetall MLG 27"),
            ("20mm/85  GAM-B01", "20mm/85  GAM-B01 HE-I", 50, 180, 90, None, "Stbd Oerlikon 20 mm"),
            ("20mm/85  GAM-B01", "20mm/85  GAM-B01 HE-I", 50, 180, 270, None, "Port Oerlikon 20 mm"),
        ],
        "magazine": {"27mm DM10 FAPDS": 500, "20mm/85  GAM-B01 HE-I": 1000},  # estimate
    },
    "Ijtihad FPB": {
        "country": "Brunei",
        "year": 2010,
        "note": "KDB Ijtihad (17), Berkat (18), Syafaat (19), Afiat (20); Lürssen FPB 41",
        "base": "Perdana FACM",  # 47 m, 265 t Malaysian fast attack craft: similar size
        "hull": {"length_m": 41, "beam_m": 7.7, "draft_m": 1.9, "maxSpeed_kts": 30},
        "sensors": [
            "Furuno",  # stands in for the navigation radar
        ],
        "launchers": [
            ("27mm MLG 27", "27mm DM10 FAPDS", 90, 300, 0, None, "Rheinmetall MLG 27"),
        ],
        "magazine": {"27mm DM10 FAPDS": 500},  # estimate
    },
}
