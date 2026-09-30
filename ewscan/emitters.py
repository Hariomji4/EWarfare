"""Emitter behaviour models.

Every emitter renders a *timeline* over the episode:

    band[t]   index of the band it is visible in at slot t (-1 = not visible)
    power[t]  received power at the ES antenna (dBm)

"Visible" means the transmission reaches our receiver: a spatially scanning
radar is visible only while its main beam sweeps across us; a frequency-agile
emitter is visible in whichever band it has hopped to; a comms emitter is
visible while it is keyed.

Threat weights express the tactical importance of intercepting that class; the
receiver does NOT know them (no prior intelligence) - they are used only for the
reward signal and the threat-weighted figures of merit.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np

THREAT = {
    "scanning_radar": 2.0,
    "tracking_radar": 3.0,
    "agile_radar": 3.0,
    "comms": 1.0,
    "beacon": 0.5,
}


@dataclass
class Emitter:
    name: str = "emitter"
    erp_dbm: float = 80.0        # effective radiated power (main beam)
    range_km: float = 100.0
    start: int = 0               # first slot it may radiate (pop-up emitters start > 0)
    stop: int | None = None      # last slot (exclusive); None = until end
    kind: str = field(default="generic", init=False)

    @property
    def threat(self) -> float:
        return THREAT.get(self.kind, 1.0)

    # subclasses implement _pattern -> band array (T,), -1 when not visible
    def _pattern(self, T: int, rng: np.random.Generator) -> np.ndarray:  # pragma: no cover
        raise NotImplementedError

    def timeline(self, T: int, rng: np.random.Generator, receiver) -> tuple[np.ndarray, np.ndarray]:
        band = self._pattern(T, rng).astype(np.int64)
        t = np.arange(T)
        stop = T if self.stop is None else self.stop
        band[(t < self.start) | (t >= stop)] = -1
        band[band >= receiver.cfg.n_bands] = -1
        f = receiver.band_centers_ghz[np.clip(band, 0, None)]
        power = receiver.received_power_dbm(self.erp_dbm, self.range_km, f)
        power = np.where(band >= 0, power, -np.inf)
        return band, power

    def to_dict(self) -> dict:
        d = asdict(self)
        d["kind"] = self.kind
        return d


@dataclass
class ScanningRadar(Emitter):
    """Search radar with a rotating (circular scan) antenna on a fixed band.

    Its main beam illuminates us for ``beam_width`` slots once every
    ``scan_period`` slots (the classic periodic 'window' intercept problem).
    """
    band: int = 0
    scan_period: int = 60
    beam_width: int = 3
    phase: int | None = None
    period_jitter: float = 0.0   # fractional jitter on each revolution
    kind: str = field(default="scanning_radar", init=False)

    def _pattern(self, T, rng):
        out = np.full(T, -1)
        phase = rng.integers(0, self.scan_period) if self.phase is None else self.phase
        t0 = -phase
        while t0 < T:
            lo, hi = max(t0, 0), min(t0 + self.beam_width, T)
            if hi > lo:
                out[lo:hi] = self.band
            step = self.scan_period
            if self.period_jitter > 0:
                step = max(self.beam_width + 1,
                           int(round(step * (1 + rng.uniform(-self.period_jitter, self.period_jitter)))))
            t0 += step
        return out


@dataclass
class TrackingRadar(Emitter):
    """Fire-control / tracking radar: once it locks on it illuminates continuously."""
    band: int = 0
    kind: str = field(default="tracking_radar", init=False)

    def _pattern(self, T, rng):
        return np.full(T, self.band)


@dataclass
class AgileRadar(Emitter):
    """Frequency-agile radar hopping across a subset of bands.

    pattern='cyclic' repeats a fixed hop sequence (learnable), pattern='random'
    draws a fresh band every hop (unpredictable). Optional spatial scanning
    (scan_period/beam_width) gates visibility as for ScanningRadar.
    """
    bands: list = field(default_factory=lambda: [0, 1, 2, 3])
    hop_dwell: int = 2
    pattern: str = "cyclic"
    scan_period: int | None = None
    beam_width: int | None = None
    kind: str = field(default="agile_radar", init=False)

    def _pattern(self, T, rng):
        bands = np.asarray(self.bands)
        n_hops = T // self.hop_dwell + 2
        if self.pattern == "cyclic":
            seq = rng.permutation(bands)
            hops = np.resize(seq, n_hops)
            hops = np.roll(hops, -rng.integers(0, len(seq)))
        else:
            hops = rng.choice(bands, size=n_hops)
        out = np.repeat(hops, self.hop_dwell)[:T].copy()
        if self.scan_period and self.beam_width:
            phase = rng.integers(0, self.scan_period)
            vis = ((np.arange(T) + phase) % self.scan_period) < self.beam_width
            out[~vis] = -1
        return out


@dataclass
class CommsEmitter(Emitter):
    """Push-to-talk / data link: two-state Markov on/off bursts on one band."""
    band: int = 0
    mean_on: float = 8.0
    mean_off: float = 30.0
    kind: str = field(default="comms", init=False)

    def _pattern(self, T, rng):
        out = np.full(T, -1)
        p_on_off = 1.0 / max(self.mean_on, 1.0)
        p_off_on = 1.0 / max(self.mean_off, 1.0)
        on = rng.random() < self.mean_on / (self.mean_on + self.mean_off)
        u = rng.random(T)
        for t in range(T):
            if on:
                out[t] = self.band
                if u[t] < p_on_off:
                    on = False
            elif u[t] < p_off_on:
                on = True
        return out


@dataclass
class Beacon(Emitter):
    """Periodic beacon / navigation emitter (low threat, highly regular)."""
    band: int = 0
    period: int = 25
    duty: int = 2
    kind: str = field(default="beacon", init=False)

    def _pattern(self, T, rng):
        phase = rng.integers(0, self.period)
        vis = ((np.arange(T) + phase) % self.period) < self.duty
        return np.where(vis, self.band, -1)


KINDS = {
    "scanning_radar": ScanningRadar,
    "tracking_radar": TrackingRadar,
    "agile_radar": AgileRadar,
    "comms": CommsEmitter,
    "beacon": Beacon,
}


def emitter_from_dict(d: dict) -> Emitter:
    d = dict(d)
    kind = d.pop("kind")
    cls = KINDS[kind]
    allowed = set(cls.__dataclass_fields__) - {"kind"}
    return cls(**{k: v for k, v in d.items() if k in allowed})
