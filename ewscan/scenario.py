"""Scenarios: sets of emitters in the RF environment.

``random_scenario`` produces a fresh randomised emitter laydown every call.
Schedulers are trained and evaluated on these, which models the operational
condition of the problem: *no prior reliable intelligence* of emitters or their
operating characteristics. Presets are hand-built situations for demos.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .emitters import (AgileRadar, Beacon, CommsEmitter, Emitter, ScanningRadar,
                       TrackingRadar, emitter_from_dict)


@dataclass
class Scenario:
    name: str = "custom"
    description: str = ""
    n_bands: int = 16
    T: int = 1000
    emitters: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"name": self.name, "description": self.description, "n_bands": self.n_bands,
                "T": self.T, "emitters": [e.to_dict() for e in self.emitters]}

    @staticmethod
    def from_dict(d: dict) -> "Scenario":
        return Scenario(name=d.get("name", "custom"), description=d.get("description", ""),
                        n_bands=int(d.get("n_bands", 16)), T=int(d.get("T", 1000)),
                        emitters=[emitter_from_dict(e) for e in d.get("emitters", [])])


# --------------------------------------------------------------------------- random
def random_scenario(rng: np.random.Generator, n_bands: int = 16, T: int = 1000,
                    density: float = 1.0) -> Scenario:
    """Randomised emitter laydown (domain randomisation for training/testing)."""
    em: list[Emitter] = []
    band = lambda: int(rng.integers(0, n_bands))
    k = lambda lo, hi: int(rng.integers(lo, hi + 1) * density + 0.5) if density != 1 else int(rng.integers(lo, hi + 1))

    for i in range(k(2, 4)):
        em.append(ScanningRadar(name=f"SR-{i + 1}", band=band(),
                                scan_period=int(rng.integers(24, 150)),
                                beam_width=int(rng.integers(2, 7)),
                                erp_dbm=float(rng.uniform(88, 100)),
                                range_km=float(rng.uniform(40, 250)),
                                start=int(rng.integers(0, T // 3)) if rng.random() < 0.3 else 0,
                                period_jitter=float(rng.choice([0.0, 0.0, 0.02]))))
    for i in range(k(0, 2)):
        nb = int(rng.integers(3, 7))
        scanning = rng.random() < 0.4
        em.append(AgileRadar(name=f"AG-{i + 1}",
                             bands=sorted(rng.choice(n_bands, size=nb, replace=False).tolist()),
                             hop_dwell=int(rng.integers(1, 5)),
                             pattern=str(rng.choice(["cyclic", "cyclic", "random"])),
                             scan_period=int(rng.integers(30, 100)) if scanning else None,
                             beam_width=int(rng.integers(6, 15)) if scanning else None,
                             erp_dbm=float(rng.uniform(85, 98)),
                             range_km=float(rng.uniform(30, 180)),
                             start=int(rng.integers(0, T // 2)) if rng.random() < 0.5 else 0))
    if rng.random() < 0.6:
        em.append(TrackingRadar(name="TR-1", band=band(),
                                erp_dbm=float(rng.uniform(80, 92)),
                                range_km=float(rng.uniform(20, 120)),
                                start=int(rng.integers(T // 5, int(T * 0.8)))))
    for i in range(k(1, 4)):
        em.append(CommsEmitter(name=f"CM-{i + 1}", band=band(),
                               mean_on=float(rng.uniform(3, 25)), mean_off=float(rng.uniform(8, 80)),
                               erp_dbm=float(rng.uniform(60, 72)),
                               range_km=float(rng.uniform(5, 50))))
    for i in range(k(0, 2)):
        em.append(Beacon(name=f"BC-{i + 1}", band=band(), period=int(rng.integers(10, 60)),
                         duty=int(rng.integers(1, 4)), erp_dbm=float(rng.uniform(60, 75)),
                         range_km=float(rng.uniform(5, 40))))
    return Scenario(name="random", description="Randomised laydown - no prior intelligence",
                    n_bands=n_bands, T=T, emitters=em)


# --------------------------------------------------------------------------- presets
def _air_defence(n_bands=16, T=1000):
    return Scenario(
        name="air_defence",
        description="Integrated air defence: three search radars, a frequency-agile "
                    "acquisition radar, comms clutter and a tracking radar that pops up at t=450.",
        n_bands=n_bands, T=T, emitters=[
            ScanningRadar(name="Search-A", band=2, scan_period=97, beam_width=4, erp_dbm=96, range_km=120),
            ScanningRadar(name="Search-B", band=7, scan_period=61, beam_width=3, erp_dbm=94, range_km=90),
            ScanningRadar(name="Search-C", band=12, scan_period=41, beam_width=2, erp_dbm=92, range_km=70),
            AgileRadar(name="Agile-Acq", bands=[4, 5, 9, 10, 14], hop_dwell=3, pattern="cyclic",
                       erp_dbm=92, range_km=80),
            TrackingRadar(name="FireCtl", band=11, erp_dbm=88, range_km=40, start=450),
            CommsEmitter(name="Datalink", band=0, mean_on=15, mean_off=20, erp_dbm=70, range_km=20),
            CommsEmitter(name="Voice", band=1, mean_on=6, mean_off=40, erp_dbm=66, range_km=15),
            Beacon(name="NavBeacon", band=15, period=20, duty=2, erp_dbm=70, range_km=10),
        ])


def _agile_threat(n_bands=16, T=1000):
    return Scenario(
        name="agile_threat",
        description="Two frequency-agile radars (one cyclic hop pattern, one random) plus "
                    "periodic search radars.",
        n_bands=n_bands, T=T, emitters=[
            AgileRadar(name="Agile-Cyclic", bands=[1, 3, 6, 8, 13, 15], hop_dwell=2, pattern="cyclic",
                       erp_dbm=94, range_km=90),
            AgileRadar(name="Agile-Random", bands=[2, 5, 9, 11], hop_dwell=3, pattern="random",
                       erp_dbm=94, range_km=90, scan_period=70, beam_width=12),
            ScanningRadar(name="Search-A", band=4, scan_period=83, beam_width=4, erp_dbm=96, range_km=150),
            ScanningRadar(name="Search-B", band=10, scan_period=53, beam_width=3, erp_dbm=95, range_km=100),
            CommsEmitter(name="Datalink", band=7, mean_on=12, mean_off=30, erp_dbm=70, range_km=25),
        ])


def _dense_comms(n_bands=16, T=1000):
    em = [CommsEmitter(name=f"Comms-{i + 1}", band=b, mean_on=20, mean_off=10, erp_dbm=70, range_km=15)
          for i, b in enumerate([0, 1, 3, 5, 6, 8, 9, 14])]
    em += [ScanningRadar(name="Search-A", band=11, scan_period=73, beam_width=3, erp_dbm=96, range_km=140),
           ScanningRadar(name="Search-B", band=13, scan_period=47, beam_width=2, erp_dbm=94, range_km=90),
           TrackingRadar(name="FireCtl", band=4, erp_dbm=88, range_km=50, start=600)]
    return Scenario(name="dense_comms",
                    description="Busy spectrum: eight non-threatening comms nets hide two search "
                                "radars; a fire-control radar appears at t=600.",
                    n_bands=n_bands, T=T, emitters=em)


def _popup(n_bands=16, T=1000):
    return Scenario(
        name="popup_threats",
        description="Quiet spectrum at first; new threats pop up at t=200, 400 and 650.",
        n_bands=n_bands, T=T, emitters=[
            ScanningRadar(name="Search-A", band=6, scan_period=67, beam_width=4, erp_dbm=96, range_km=120),
            CommsEmitter(name="Datalink", band=2, mean_on=10, mean_off=25, erp_dbm=70, range_km=20),
            ScanningRadar(name="PopUp-SR", band=13, scan_period=37, beam_width=3, erp_dbm=94, range_km=80,
                          start=200),
            AgileRadar(name="PopUp-Agile", bands=[0, 4, 8, 12], hop_dwell=2, pattern="cyclic",
                       erp_dbm=92, range_km=70, start=400),
            TrackingRadar(name="PopUp-FC", band=9, erp_dbm=88, range_km=40, start=650),
        ])


PRESETS = {
    "air_defence": _air_defence,
    "agile_threat": _agile_threat,
    "dense_comms": _dense_comms,
    "popup_threats": _popup,
}


def preset(name: str, n_bands: int = 16, T: int = 1000) -> Scenario:
    return PRESETS[name](n_bands, T)
