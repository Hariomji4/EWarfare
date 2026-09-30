"""Online observation tracker (the receiver's 'memory').

The receiver only ever sees the band it dwelt on: a hit (detection) or a miss.
From this partial, noisy stream the tracker maintains per band:

* visit / detection history and an EMA of occupancy,
* a **scan-period estimate** obtained with a difference histogram over
  detection-event times (as in PRI deinterleaving): the largest period P for
  which (almost) every pairwise difference is an integer multiple of P,
* a **phase model**: detections and visits folded modulo P, giving
  P(active at t) for periodic emitters and hence a predicted next-on time,
* engineered state features used by the model-based and RL schedulers.

Only the chosen band changes each slot, so updates are O(1) bands per step.
"""
from __future__ import annotations

import numpy as np

N_FEATURES = 13


class ObservationTracker:
    def __init__(self, n_bands: int, T: int, min_period: int = 6, max_period: int = 200,
                 revisit_target: int = 60, noise_floor_dbm: float = -74.0):
        self.N, self.T = n_bands, T
        self.min_period, self.max_period = min_period, max_period
        self.revisit_target = revisit_target
        self.noise_floor = noise_floor_dbm
        self.tol = 3
        self.reset()

    def reset(self):
        N = self.N
        self.last_visit = np.full(N, -1, dtype=np.int64)
        self.last_det = np.full(N, -1, dtype=np.int64)
        self.visits = np.zeros(N, dtype=np.int64)
        self.dets = np.zeros(N, dtype=np.int64)
        self.occ = np.full(N, 0.25)
        self.snr = np.zeros(N)
        self.visit_t = [[] for _ in range(N)]
        self.visit_d = [[] for _ in range(N)]
        self.events = [[] for _ in range(N)]
        self.period = np.zeros(N, dtype=np.int64)
        self.period_conf = np.zeros(N)
        self.phase_prob: list[np.ndarray | None] = [None] * N
        self.t = 0

    # ------------------------------------------------------------ update
    def update(self, t: int, band: int, detected: bool, power_dbm: float | None = None):
        b = band
        self.t = t + 1
        self.visits[b] += 1
        self.last_visit[b] = t
        self.visit_t[b].append(t)
        self.visit_d[b].append(bool(detected))
        self.occ[b] += 0.2 * (float(detected) - self.occ[b])
        new_event = False
        if detected:
            if self.last_det[b] < 0 or t - self.last_det[b] > self.tol:
                self.events[b].append(t)
                new_event = True
            self.last_det[b] = t
            self.dets[b] += 1
            if power_dbm is not None:
                self.snr[b] = power_dbm - self.noise_floor
        if new_event and len(self.events[b]) >= 2:
            self._estimate_period(b)
        self._refresh_phase(b)

    def _estimate_period(self, b: int):
        ev = np.asarray(self.events[b][-16:])
        i, j = np.triu_indices(len(ev), 1)
        D = (ev[j] - ev[i]).astype(float)
        hi = min(self.max_period, int(D.max()))
        if hi < self.min_period:
            return
        P = np.arange(self.min_period, hi + 1, dtype=float)
        k = np.maximum(np.round(D[None, :] / P[:, None]), 1)
        resid = np.abs(D[None, :] - k * P[:, None])
        score = (resid <= self.tol).mean(axis=1)
        ok = np.flatnonzero(score >= 0.8)
        if len(ok) == 0:
            self.period[b], self.period_conf[b] = 0, 0.0
            return
        best = ok[-1]
        self.period[b] = int(P[best])
        # confidence grows with the number of consistent events
        self.period_conf[b] = float(score[best]) * min(1.0, 0.2 + 0.2 * (len(ev) - 1))

    def _refresh_phase(self, b: int):
        P = int(self.period[b])
        if P <= 0:
            self.phase_prob[b] = None
            return
        vt = np.asarray(self.visit_t[b])
        vd = np.asarray(self.visit_d[b], dtype=float)
        ph = vt % P
        dets = np.bincount(ph, weights=vd, minlength=P)
        vis = np.bincount(ph, minlength=P).astype(float)
        # circular smoothing over +-1 bin (beam width / timing uncertainty)
        ker = lambda x: x + np.roll(x, 1) + np.roll(x, -1)
        d, v = ker(dets), ker(vis)
        prior = 0.5 * self.occ[b]
        self.phase_prob[b] = (d + 0.5 * prior) / (v + 0.5)

    # ------------------------------------------------------------ queries
    def p_active(self, t: int) -> np.ndarray:
        """Estimated probability that each band is active at slot t."""
        p = np.where(self.visits > 0, self.occ, 0.3)
        for b in np.flatnonzero(self.period > 0):
            pp = self.phase_prob[b]
            c = self.period_conf[b]
            p[b] = c * pp[t % len(pp)] + (1 - c) * p[b]
        return p

    def time_to_next(self, t: int, horizon: int = 64) -> np.ndarray:
        """Predicted slots until each band is next active (horizon if unknown)."""
        out = np.full(self.N, horizon, dtype=np.int64)
        base = np.where(self.visits > 0, self.occ, 0.3)
        out[base > 0.5] = 0
        for b in np.flatnonzero(self.period > 0):
            pp = self.phase_prob[b]
            P = len(pp)
            idx = (t + np.arange(min(P, horizon))) % P
            hits = np.flatnonzero(pp[idx] > 0.5)
            out[b] = hits[0] if len(hits) else horizon
        return out

    def features(self, t: int, p_extra: np.ndarray | None = None) -> np.ndarray:
        """Per-band state features, shape (N, N_FEATURES), all roughly in [0, 1]."""
        N = self.N
        never_v = self.last_visit < 0
        never_d = self.last_det < 0
        tsv = np.where(never_v, 1.0, np.minimum(1.0, (t - self.last_visit) / (4 * N)))
        tsd = np.where(never_d, 1.0, np.minimum(1.0, (t - self.last_det) / 200))
        revisit = np.where(never_d, 1.0, np.minimum(1.0, (t - self.last_det) / self.revisit_target))
        p_now = self.p_active(t)
        p_soon = np.maximum.reduce([self.p_active(t + k) for k in range(1, 4)])
        ttn = self.time_to_next(t, 64) / 64
        per = self.period / self.max_period
        feats = np.stack([
            tsv, never_v.astype(float), tsd, (~never_d).astype(float), self.occ,
            p_now, p_soon, self.period_conf, per, ttn,
            np.clip(self.snr / 30, 0, 1), revisit,
            p_now if p_extra is None else p_extra,
        ], axis=1)
        return feats.astype(np.float32)

    def global_features(self, t: int) -> np.ndarray:
        return np.array([t / self.T, (self.last_visit >= 0).mean(), (self.last_det >= 0).mean()],
                        dtype=np.float32)
