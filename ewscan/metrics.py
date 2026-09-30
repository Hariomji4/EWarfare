"""Figures of merit for interception performance (computed against ground truth).

Detection
    pd                  P(detect | dwelt on an active band)
    pfa                 P(detect | dwelt on an empty band)
    sensitivity_dbm     minimum received power for Pd = 0.9 at design Pfa
Interception
    intercept_ratio     fraction of emitter transmission events (a beam
                        illumination, a hop dwell, a comms burst...) intercepted
    threat_weighted_ir  same, weighted by emitter threat
    emitters_found      fraction of detectable emitters intercepted at least once
    mean_intercept_time mean time from an emitter first radiating to its first
                        intercept (slots and ms; never-intercepted = censored)
    mean_info_age       mean time since each live emitter was last intercepted
    intercept_rate      true intercepts per second
    hit_rate            fraction of dwells that produced a true intercept
Learning
    avg_reward          average reward (cost function) per dwell
    prediction_accuracy % correct activity predictions on the dwelt band
    all_band_accuracy   % correct activity predictions over all bands
    intercept_time_error mean |predicted - actual| slots to next activity
"""
from __future__ import annotations

import numpy as np


def _runs(mask: np.ndarray, band: np.ndarray):
    """Contiguous runs where mask is True and band constant -> list of (start, end)."""
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return []
    brk = np.flatnonzero((np.diff(idx) > 1) | (np.diff(band[idx]) != 0)) + 1
    starts = np.r_[idx[0], idx[brk]]
    ends = np.r_[idx[brk - 1], idx[-1]] + 1
    return list(zip(starts, ends))


def time_to_next_active(active: np.ndarray, horizon: int = 64) -> np.ndarray:
    """For each band and slot, slots until the band is next active (capped)."""
    N, T = active.shape
    out = np.full((N, T), horizon, dtype=np.int64)
    nxt = np.full(N, T + horizon, dtype=np.int64)
    for t in range(T - 1, -1, -1):
        nxt = np.where(active[:, t], t, nxt)
        out[:, t] = np.minimum(nxt - t, horizon)
    return out


def compute_metrics(env, log: dict) -> dict:
    a, det = log["actions"], log["detections"]
    T = env.T
    tt = np.arange(T)
    dwell_s = env.rx.cfg.dwell_ms / 1000
    on_active = env.active[a, tt]
    hits = det & on_active
    fas = det & ~on_active

    m: dict = {}
    m["pd"] = float(hits.sum() / max(on_active.sum(), 1))
    m["pfa"] = float(fas.sum() / max((~on_active).sum(), 1))
    m["sensitivity_dbm"] = round(env.rx.sensitivity_dbm(0.9), 2)
    m["hit_rate"] = float(hits.mean())
    m["intercept_rate_per_s"] = float(hits.sum() / (T * dwell_s))

    E = env.em_band.shape[0]
    n_ev = n_hit = w_ev = w_hit = 0.0
    first_times, ages, found = [], [], 0
    # emitters whose mean Pd while radiating is < 0.2 are below receiver
    # sensitivity: no scan strategy can find them, so they are excluded from
    # the time-based figures (they still count in intercept ratios)
    detectable = []
    per_emitter = []
    for e in range(E):
        b = env.em_band[e]
        live = b >= 0
        if not live.any():
            continue
        hit_e = live & (a == b) & det
        runs = _runs(live, b)
        caught = sum(bool(hit_e[s:t].any()) for s, t in runs)
        w = env.em_threat[e]
        n_ev += len(runs); n_hit += caught
        w_ev += w * len(runs); w_hit += w * caught
        start = env.em_start[e]
        mean_pd = float(env.rx.pd_from_power(env.em_power[e, live]).mean())
        hit_idx = np.flatnonzero(hit_e)
        if len(hit_idx):
            found += 1
            first = int(hit_idx[0] - start)
        else:
            first = int(T - start)
        if mean_pd >= 0.2:
            first_times.append(first)
        # information age over the emitter's life
        last = np.full(T, -1)
        last[hit_idx] = hit_idx
        last = np.maximum.accumulate(last)
        span = tt >= start
        age = np.where(last >= 0, tt - last, tt - start)[span]
        if mean_pd >= 0.2:
            ages.append(float(age.mean()))
            detectable.append(bool(len(hit_idx)))
        per_emitter.append({"name": env.scenario.emitters[e].name, "kind": env.scenario.emitters[e].kind,
                            "mean_pd": round(mean_pd, 3), "events": len(runs), "intercepted": caught,
                            "first_intercept_slot": int(hit_idx[0]) if len(hit_idx) else None,
                            "time_to_intercept": first if len(hit_idx) else None})
    n_em = len(first_times)
    m["intercept_ratio"] = float(n_hit / max(n_ev, 1))
    m["threat_weighted_ir"] = float(w_hit / max(w_ev, 1))
    m["emitters_found"] = float(np.mean(detectable)) if detectable else 0.0
    m["mean_intercept_time_slots"] = float(np.mean(first_times)) if n_em else 0.0
    m["mean_intercept_time_ms"] = m["mean_intercept_time_slots"] * env.rx.cfg.dwell_ms
    m["mean_info_age_slots"] = float(np.mean(ages)) if n_em else 0.0
    m["avg_reward"] = float(log["rewards"].mean())
    m["total_reward"] = float(log["rewards"].sum())

    pred = log.get("pred")
    if pred is not None and not np.all(np.isnan(pred)):
        pb = pred > 0.5
        m["prediction_accuracy"] = float((pb[a, tt] == on_active).mean())
        m["all_band_accuracy"] = float((pb == env.active).mean())
        tp = (pb & env.active).sum()
        m["prediction_precision"] = float(tp / max(pb.sum(), 1))
        m["prediction_recall"] = float(tp / max(env.active.sum(), 1))
    ttn = log.get("ttn")
    if ttn is not None and not np.all(np.isnan(ttn)):
        H = 64
        actual = time_to_next_active(env.active, H)
        ok = actual < H
        m["intercept_time_error_slots"] = float(np.abs(np.minimum(ttn, H)[ok] - actual[ok]).mean())
    m["per_emitter"] = per_emitter
    return m


SUMMARY_KEYS = ["pd", "pfa", "hit_rate", "intercept_ratio", "threat_weighted_ir", "emitters_found",
                "mean_intercept_time_slots", "mean_info_age_slots", "intercept_rate_per_s",
                "avg_reward", "prediction_accuracy", "all_band_accuracy", "intercept_time_error_slots"]
