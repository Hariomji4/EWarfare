"""Receiver system model.

The own receiver covers [f_min, f_max] split into ``n_bands`` contiguous bands.
Its instantaneous bandwidth equals one band, so at every time slot it can dwell
on exactly one band (a swept / scanning superheterodyne style receiver).

Detection is modelled as a square-law (energy) detector integrating ``n_samples``
independent complex samples per dwell:

    H0 (noise only):  statistic ~ chi2(2M)
    H1 (signal):      statistic ~ noncentral-chi2(2M, 2M * SNR)

The threshold is set for the design probability of false alarm, which gives an
exact Pd(SNR) curve. Sensitivity is the minimum received power for Pd = 0.9.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
from scipy.stats import chi2, ncx2


@dataclass
class ReceiverConfig:
    f_min_ghz: float = 2.0
    f_max_ghz: float = 18.0
    n_bands: int = 16
    noise_figure_db: float = 10.0
    antenna_gain_dbi: float = 3.0
    n_samples: int = 16          # effective independent samples integrated per dwell
    pfa: float = 1e-3            # design false-alarm probability per dwell
    dwell_ms: float = 10.0       # duration of one time slot (dwell)

    def to_dict(self) -> dict:
        return asdict(self)


class ReceiverModel:
    def __init__(self, cfg: ReceiverConfig | None = None):
        self.cfg = cfg or ReceiverConfig()
        c = self.cfg
        self.band_bw_hz = (c.f_max_ghz - c.f_min_ghz) * 1e9 / c.n_bands
        edges = np.linspace(c.f_min_ghz, c.f_max_ghz, c.n_bands + 1)
        self.band_edges_ghz = edges
        self.band_centers_ghz = 0.5 * (edges[:-1] + edges[1:])
        self.noise_floor_dbm = -174.0 + 10 * np.log10(self.band_bw_hz) + c.noise_figure_db
        self.threshold = chi2.isf(c.pfa, 2 * c.n_samples)

    # ------------------------------------------------------------------ physics
    def received_power_dbm(self, erp_dbm, range_km, f_ghz):
        """Free-space received power at the ES antenna."""
        fspl = 20 * np.log10(np.maximum(range_km, 1e-3)) + 20 * np.log10(f_ghz * 1e3) + 32.44
        return erp_dbm - fspl + self.cfg.antenna_gain_dbi

    def snr_db(self, power_dbm):
        return np.asarray(power_dbm) - self.noise_floor_dbm

    def pd_from_snr_db(self, snr_db):
        snr = 10 ** (np.asarray(snr_db, dtype=float) / 10)
        m = self.cfg.n_samples
        return ncx2.sf(self.threshold, 2 * m, 2 * m * snr)

    def pd_from_power(self, power_dbm):
        return self.pd_from_snr_db(self.snr_db(power_dbm))

    # ---------------------------------------------------------- figures of merit
    def required_snr_db(self, pd: float = 0.9) -> float:
        lo, hi = -30.0, 40.0
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            if self.pd_from_snr_db(mid) < pd:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)

    def sensitivity_dbm(self, pd: float = 0.9) -> float:
        return float(self.noise_floor_dbm + self.required_snr_db(pd))

    def summary(self) -> dict:
        return {
            "n_bands": self.cfg.n_bands,
            "band_bw_mhz": self.band_bw_hz / 1e6,
            "total_bw_ghz": self.cfg.f_max_ghz - self.cfg.f_min_ghz,
            "noise_floor_dbm": round(float(self.noise_floor_dbm), 2),
            "required_snr_db_pd90": round(self.required_snr_db(0.9), 2),
            "sensitivity_dbm_pd90": round(self.sensitivity_dbm(0.9), 2),
            "design_pfa": self.cfg.pfa,
            "dwell_ms": self.cfg.dwell_ms,
            "band_centers_ghz": [round(float(f), 3) for f in self.band_centers_ghz],
        }
