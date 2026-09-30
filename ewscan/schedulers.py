"""Receiver schedulers: decide which band to dwell on at every time slot.

Open-loop (pre-planned, no feedback)
    RoundRobinScheduler   classic fixed sweep across the bands (baseline)
    RandomSweepScheduler  sweep with a fresh random band order every cycle -
                          breaks synchronisation lock-out with periodic emitters
    RandomScheduler       uniformly random band

Closed-loop (adapt to hits and misses)
    ThompsonScheduler     discounted Thompson-sampling multi-armed bandit
    ModelBasedScheduler   'smart scan': period/phase estimation + revisit
                          value + coverage (exploration) scoring
    PredictorScheduler    GRU activity predictor driven (see predictor.py)
    DQNScheduler          reinforcement-learning scheduler (see rl.py)

Interface: reset(N, T, rng, noise_floor) -> select(t) -> update(t, band, det, power).
Optional: predictions(t) -> P(active) per band at slot t; time_to_next(t).
"""
from __future__ import annotations

import numpy as np

from .tracker import ObservationTracker


class Scheduler:
    name = "base"
    label = "Base"
    closed_loop = False

    def reset(self, n_bands: int, T: int, rng: np.random.Generator, noise_floor: float = -74.0):
        self.N, self.T, self.rng = n_bands, T, rng

    def select(self, t: int) -> int:  # pragma: no cover
        raise NotImplementedError

    def update(self, t: int, band: int, detected: bool, power: float | None):
        pass

    def predictions(self, t: int):
        return None

    def time_to_next(self, t: int):
        return None


# ============================================================== open loop
class RoundRobinScheduler(Scheduler):
    name, label = "round_robin", "Round-robin sweep (open loop)"

    def select(self, t):
        return t % self.N


class RandomSweepScheduler(Scheduler):
    name, label = "random_sweep", "Randomised sweep (open loop)"

    def reset(self, *a, **k):
        super().reset(*a, **k)
        self.order = self.rng.permutation(self.N)

    def select(self, t):
        if t % self.N == 0:
            self.order = self.rng.permutation(self.N)
        return int(self.order[t % self.N])


class RandomScheduler(Scheduler):
    name, label = "random", "Random dwell"

    def select(self, t):
        return int(self.rng.integers(self.N))


# ============================================================== bandit
class ThompsonScheduler(Scheduler):
    """Discounted Thompson sampling: Beta posterior on P(hit) per band, with
    forgetting so that it can follow a non-stationary environment."""
    name, label, closed_loop = "thompson", "Discounted Thompson bandit", True

    def __init__(self, gamma: float = 0.98):
        self.gamma = gamma

    def reset(self, *a, **k):
        super().reset(*a, **k)
        self.a = np.ones(self.N)
        self.b = np.ones(self.N)

    def select(self, t):
        return int(np.argmax(self.rng.beta(self.a, self.b)))

    def update(self, t, band, detected, power):
        self.a = 1 + self.gamma * (self.a - 1)
        self.b = 1 + self.gamma * (self.b - 1)
        self.a[band] += float(detected)
        self.b[band] += 1 - float(detected)

    def predictions(self, t):
        return self.a / (self.a + self.b)


# ============================================================== model based
class TrackerScheduler(Scheduler):
    """Base class for schedulers built on the ObservationTracker."""
    closed_loop = True

    def reset(self, n_bands, T, rng, noise_floor=-74.0):
        super().reset(n_bands, T, rng, noise_floor)
        self.tracker = ObservationTracker(n_bands, T, noise_floor_dbm=noise_floor)

    def update(self, t, band, detected, power):
        self.tracker.update(t, band, detected, power)

    def predictions(self, t):
        return self.tracker.p_active(t)

    def time_to_next(self, t):
        return self.tracker.time_to_next(t)


class ModelBasedScheduler(TrackerScheduler):
    """Smart scan with explicit emitter models: coverage sweep + timed interrupts.

    1. Coverage: the default dwell goes to the band that has gone longest
       without a visit (never-visited bands first) -> the rapid initial sweep
       and a bounded revisit time for discovering new / pop-up emitters.
    2. Opportunistic interception: when a band's scan-period/phase model is
       confident that a beam illuminates us *now*, and that emitter is due for
       re-intercept, the sweep is interrupted for that single dwell. Beams are
       short, so catching them costs little coverage time.
    3. Period acquisition: after a transient intercept (a beam that is gone on
       the next visit) with no period model yet, the band is 'watched' - revisited
       every ``watch_step`` slots (<= beam width) until the next illumination is
       caught, which measures the scan period. One band is watched at a time.
    4. De-prioritisation: bands holding a continuous emitter that was just
       intercepted are skipped until their revisit value recovers, instead of
       wasting dwells on non-informative repeat intercepts.
    """
    name, label = "model_based", "Smart scan - model based"

    def __init__(self, revisit_target: int = 30, p_interrupt: float = 0.5, conf_min: float = 0.3,
                 skip_occ: float = 0.7, watch_step: int = 3, watch_max: int = 160,
                 watch_after_sweeps: int = 2):
        self.R, self.p_int, self.conf_min, self.skip_occ = revisit_target, p_interrupt, conf_min, skip_occ
        self.watch_step, self.watch_max = watch_step, watch_max
        self.watch_after = watch_after_sweeps

    def reset(self, *a, **k):
        super().reset(*a, **k)
        self.watch_band, self.watch_until = -1, -1
        self.watch_queue: list[int] = []
        self.pending: dict[int, int] = {}   # band -> slot of the transient hit

    def update(self, t, band, detected, power):
        tr = self.tracker
        n_ev = len(tr.events[band])
        super().update(t, band, detected, power)
        new_event = len(tr.events[band]) > n_ev
        if band == self.watch_band and new_event:
            self.watch_band = -1                      # next beam caught -> period measured
        if detected and tr.period_conf[band] < self.conf_min:
            self.pending[band] = t
        elif not detected and band in self.pending:
            # the emitter seen here has gone quiet -> transient (scanning beam / burst)
            if tr.occ[band] < 0.6 and band != self.watch_band and band not in self.watch_queue:
                self.watch_queue.append(band)
            del self.pending[band]

    def select(self, t):
        tr = self.tracker
        if self.watch_band >= 0 and (t > self.watch_until or tr.period_conf[self.watch_band] >= 0.5):
            self.watch_band = -1
        # rapid initial sweep(s) of the whole spectrum take priority over acquisition
        while self.watch_band < 0 and self.watch_queue and t >= self.watch_after * self.N:
            b = self.watch_queue.pop(0)
            if tr.period_conf[b] < 0.5:
                self.watch_band, self.watch_until = b, t + self.watch_max
        value = np.where(tr.last_det < 0, 1.0, np.minimum(1.0, (t - tr.last_det) / self.R))
        cover = np.where(tr.last_visit < 0, 10.0, (t - tr.last_visit) / self.N)
        recent_cont = (tr.occ > self.skip_occ) & (value < 1.0)
        cover = np.where(recent_cont, cover * 0.3, cover)
        p = tr.p_active(t)
        interrupt = (tr.period_conf >= self.conf_min) & (p >= self.p_int) & (value >= 0.5)
        score = cover + interrupt * (20.0 + p) + 1e-3 * self.rng.random(self.N)
        wb = self.watch_band
        if wb >= 0 and t - tr.last_visit[wb] >= self.watch_step:
            score[wb] += 15.0
        return int(np.argmax(score))


def run_episode(env, scheduler: Scheduler, seed: int = 0, record: bool = True) -> dict:
    """Run one full episode; returns the log used by metrics and the web UI."""
    rng = np.random.default_rng(seed + 12345)
    env.reset()
    scheduler.reset(env.N, env.T, rng, env.rx.noise_floor_dbm)
    N, T = env.N, env.T
    pred = np.full((N, T), np.nan) if record else None
    ttn = np.full((N, T), np.nan) if record else None
    while not env.done:
        t = env.t
        if record:
            p = scheduler.predictions(t)
            if p is not None:
                pred[:, t] = p
            q = scheduler.time_to_next(t)
            if q is not None:
                ttn[:, t] = q
        band = scheduler.select(t)
        obs, r, done, info = env.step(band)
        scheduler.update(t, band, obs["detected"], obs["power_dbm"])
    return {"actions": env.actions.copy(), "detections": env.detections.copy(),
            "rewards": env.rewards.copy(), "pred": pred, "ttn": ttn}
