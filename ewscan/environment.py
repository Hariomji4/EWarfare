"""Simulated RF environment with ground truth.

At reset the environment renders every emitter's timeline and builds the truth
grids (band x slot):

    active[b, t]   True if any emitter is transmitting (visible) in band b at t
    power[b, t]    strongest received power (dBm)
    pd[b, t]       probability our receiver detects it if tuned there
    outcome[b, t]  pre-drawn detection result if the receiver dwells on b at t
                   (signal detection w.p. pd, false alarm w.p. Pfa on empty band)

Pre-drawing outcomes makes every scheduler face the *identical* realisation of
noise for a given seed, so comparisons between strategies are fair.

Each ``step(band)`` = one dwell of the receiver. It returns what the receiver
observes (detected?, measured power) and a reward computed from the truth
(hit / miss / false alarm), which is the training signal for learning.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .receiver import ReceiverConfig, ReceiverModel
from .scenario import Scenario


@dataclass
class RewardConfig:
    first_intercept: float = 3.0     # bonus for the first intercept of an emitter (new threat)
    revisit_target: int = 60         # slots after which re-intercepting an emitter is fully rewarded
    false_alarm: float = -0.2
    dwell_cost: float = -0.02        # every dwell costs time


class RFEnvironment:
    def __init__(self, scenario: Scenario, receiver_cfg: ReceiverConfig | None = None,
                 seed: int = 0, reward_cfg: RewardConfig | None = None):
        self.scenario = scenario
        cfg = receiver_cfg or ReceiverConfig()
        cfg.n_bands = scenario.n_bands
        self.rx = ReceiverModel(cfg)
        self.rcfg = reward_cfg or RewardConfig()
        self.seed = seed
        self.N, self.T = scenario.n_bands, scenario.T
        self.reset(seed)

    # ------------------------------------------------------------------ build
    def reset(self, seed: int | None = None):
        if seed is not None:
            self.seed = seed
        rng = np.random.default_rng(self.seed)
        N, T = self.N, self.T
        E = len(self.scenario.emitters)
        self.em_band = np.full((E, T), -1, dtype=np.int64)
        self.em_power = np.full((E, T), -np.inf)
        for i, e in enumerate(self.scenario.emitters):
            self.em_band[i], self.em_power[i] = e.timeline(T, rng, self.rx)
        self.em_threat = np.array([e.threat for e in self.scenario.emitters])
        self.em_start = np.array([self._first_active(i) for i in range(E)])

        self.power = np.full((N, T), -np.inf)
        self.owner = np.full((N, T), -1, dtype=np.int64)
        cols = np.arange(T)
        for i in range(E):
            b = self.em_band[i]
            m = b >= 0
            stronger = self.em_power[i, m] > self.power[b[m], cols[m]]
            tt = cols[m][stronger]
            self.power[b[m][stronger], tt] = self.em_power[i, m][stronger]
            self.owner[b[m][stronger], tt] = i
        self.active = self.owner >= 0
        self.pd = np.where(self.active, self.rx.pd_from_power(np.where(self.active, self.power, -200)), 0.0)
        p_det = np.where(self.active, self.pd, self.rx.cfg.pfa)
        self.outcome = rng.random((N, T)) < p_det
        noise = rng.normal(0, 1.5, (N, T))
        self.meas_power = np.where(self.active, self.power, self.rx.noise_floor_dbm) + noise

        # episode bookkeeping
        self.t = 0
        self.last_hit = np.full(E, -1, dtype=np.int64)
        self.first_hit = np.full(E, -1, dtype=np.int64)
        self.actions = np.full(T, -1, dtype=np.int64)
        self.detections = np.zeros(T, dtype=bool)
        self.rewards = np.zeros(T)
        return self.observation()

    def _first_active(self, i):
        idx = np.flatnonzero(self.em_band[i] >= 0)
        return int(idx[0]) if len(idx) else -1

    # ------------------------------------------------------------------ step
    def observation(self) -> dict:
        return {"t": self.t, "n_bands": self.N, "T": self.T}

    @property
    def done(self) -> bool:
        return self.t >= self.T

    def emitters_in(self, band: int, t: int) -> np.ndarray:
        return np.flatnonzero(self.em_band[:, t] == band)

    def step(self, band: int):
        assert not self.done, "episode finished"
        t, band = self.t, int(band)
        det = bool(self.outcome[band, t])
        active = bool(self.active[band, t])
        rc = self.rcfg
        reward = rc.dwell_cost
        hit_emitters: list[int] = []
        if det and active:
            for e in self.emitters_in(band, t):
                w = self.em_threat[e]
                if self.first_hit[e] < 0:
                    self.first_hit[e] = t
                    reward += w * (1.0 + rc.first_intercept)
                else:
                    gap = t - self.last_hit[e]
                    reward += w * min(1.0, gap / rc.revisit_target)
                self.last_hit[e] = t
                hit_emitters.append(int(e))
        elif det and not active:
            reward += rc.false_alarm

        self.actions[t] = band
        self.detections[t] = det
        self.rewards[t] = reward
        self.t += 1
        obs = {"t": self.t, "band": band, "detected": det,
               "power_dbm": float(self.meas_power[band, t]) if det else None}
        info = {"hit": det and active, "false_alarm": det and not active,
                "missed": active and not det, "emitters": hit_emitters}
        return obs, float(reward), self.done, info

    # ------------------------------------------------------------------ export
    def truth_grid(self) -> np.ndarray:
        """band x slot grid: -1 empty, otherwise index of the strongest emitter."""
        return self.owner.copy()
