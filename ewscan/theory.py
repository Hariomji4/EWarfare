"""Analytical interception model and optimal periodic-scan design.

Time is discrete (1 slot = 1 dwell). A scanning receiver looks at a given band
for ``tau_r`` slots every ``T_r`` slots (for a round-robin sweep over N bands,
tau_r = 1 and T_r = N). A spatially scanning emitter illuminates us for
``tau_s`` slots every ``T_s`` slots.

Coincidence window: a look and an illumination overlap iff their relative
offset falls in a window of w = tau_r + tau_s - 1 slots.

Analytic (incommensurate periods, random phase) predictions
    per-look intercept probability     p   = min(1, w / T_s)
    interception ratio (per scan)      IR  = min(1, w / T_r)
    mean time to first intercept       E[T] = T_r/2 + T_r (1 - p) / p

Synchronisation / lock-out (exact): the relative offset advances by T_r mod T_s
per look, so only offsets on a lattice of step g = gcd(T_r, T_s) are ever
visited. Intercept is *guaranteed* for every phase iff g <= w; otherwise a
fraction of phases is never intercepted. ``exact_periodic`` evaluates this
exactly over all phases, and ``optimal_revisit`` searches the revisit period
that minimises the worst-case (guaranteed) intercept time - the vernier rule:
choose T_r so that successive looks slide across the scan by ~w slots.

Frequency-agile emitter hopping uniformly over K of the N bands, dwell h per hop,
against a round-robin sweep (optionally also beam-scanned, duty beta):
    per-slot intercept probability  q  = beta / N
    mean time to first intercept    E[T] ~ 1/q
    hop-event interception ratio    IR ~ beta * min(1, h_eff / N),  h_eff = h K/(K-1)
"""
from __future__ import annotations

from math import gcd

import numpy as np


# ------------------------------------------------------------------ analytic
def analytic_periodic(T_r: int, tau_r: int, T_s: int, tau_s: int) -> dict:
    w = tau_r + tau_s - 1
    p = min(1.0, w / T_s)
    ir = min(1.0, w / T_r)
    mean_t = T_r / 2 + T_r * (1 - p) / p
    return {"p_look": p, "intercept_ratio": ir, "mean_intercept_time": mean_t,
            "gcd": gcd(T_r, T_s), "window": w, "guaranteed": gcd(T_r, T_s) <= w}


def analytic_agile(N: int, hop_dwell: int, K: int, beta: float = 1.0) -> dict:
    """Random hopping over K bands: consecutive hops repeat a band w.p. 1/K, so a
    transmission event (run in one band) lasts h*K/(K-1) slots on average."""
    q = beta / N
    h_eff = hop_dwell * K / max(K - 1, 1)
    return {"p_slot": q, "mean_intercept_time": 1 / q, "intercept_ratio": beta * min(1.0, h_eff / N)}


# ------------------------------------------------------------------ exact
def exact_periodic(T_r: int, tau_r: int, T_s: int, tau_s: int, horizon: int | None = None) -> dict:
    """Exact statistics over all relative phases (phase-lattice model).

    Time origin = start of the emitter's first illumination (as in the
    simulator's time-to-intercept figure); the receiver's phase is uniform.
    Both processes repeat with period lcm(T_r, T_s), so if no coincidence
    occurs within one lcm, it never occurs (lock-out).
    """
    L = T_r * T_s // gcd(T_r, T_s)
    H = L + T_s
    t = np.arange(H)
    em = (t % T_s) < tau_s                                   # (H,)
    pr = np.arange(T_r)[:, None]
    rx = ((t[None, :] + pr) % T_r) < tau_r                   # (T_r, H)
    both = rx & em[None, :]
    any_ = both.any(axis=1)
    first = np.where(any_, both.argmax(axis=1), np.inf)
    # interception ratio: illumination windows (within one lcm) holding >= 1 look
    n_win = L // T_s
    win = both[:, :n_win * T_s].reshape(T_r, n_win, T_s)[:, :, :tau_s].any(axis=2)
    never = ~any_
    fin = first[any_]
    return {"mean_intercept_time": float(fin.mean()) if len(fin) else float("inf"),
            "worst_intercept_time": float(fin.max()) if not never.any() else float("inf"),
            "p_never": float(never.mean()), "intercept_ratio": float(win.mean()),
            "gcd": gcd(T_r, T_s), "window": tau_r + tau_s - 1, "guaranteed": not never.any()}


def optimal_revisit(T_s: int, tau_s: int, tau_r: int = 1, T_min: int = 16, T_max: int | None = None) -> dict:
    """Search revisit periods T_r in [T_min, T_max] for the best guaranteed intercept.

    Returns the full curve (for plotting) and the optimum by worst-case time,
    tie-broken by mean time.
    """
    T_max = T_max or T_min + max(16, T_s)
    rows = []
    for T_r in range(T_min, T_max + 1):
        ex = exact_periodic(T_r, tau_r, T_s, tau_s)
        an = analytic_periodic(T_r, tau_r, T_s, tau_s)
        rows.append({"T_r": T_r, "mean": ex["mean_intercept_time"], "worst": ex["worst_intercept_time"],
                     "p_never": ex["p_never"], "ir": ex["intercept_ratio"], "gcd": ex["gcd"],
                     "analytic_mean": an["mean_intercept_time"], "analytic_ir": an["intercept_ratio"],
                     "guaranteed": ex["guaranteed"]})
    ok = [r for r in rows if r["guaranteed"]]
    best = min(ok, key=lambda r: (r["worst"], r["mean"])) if ok else None
    return {"T_s": T_s, "tau_s": tau_s, "tau_r": tau_r, "curve": rows, "best": best,
            "round_robin": rows[0]}


def robust_revisit(T_s_range: tuple[int, int], tau_s: int, tau_r: int = 1, T_min: int = 16,
                   span: int = 16) -> dict:
    """Unknown scan period: choose T_r minimising the expected mean intercept time
    (and lock-out probability) over a uniform prior on T_s."""
    Ts = np.arange(T_s_range[0], T_s_range[1] + 1)
    rows = []
    for T_r in range(T_min, T_min + span + 1):
        ex = [exact_periodic(T_r, tau_r, int(ts), tau_s) for ts in Ts]
        p_never = float(np.mean([e["p_never"] for e in ex]))
        mean = float(np.mean([min(e["mean_intercept_time"], 1e5) for e in ex]))
        rows.append({"T_r": T_r, "expected_mean": mean, "p_lockout": p_never})
    best = min(rows, key=lambda r: (r["p_lockout"], r["expected_mean"]))
    return {"rows": rows, "best": best}


# ------------------------------------------------------------------ validation
def validate_against_simulation(n_trials: int = 200, N: int = 16, seed: int = 0) -> dict:
    """Monte-Carlo check of the analytic predictions using the full simulator
    (round-robin receiver vs single emitters with random phase)."""
    from .emitters import AgileRadar, ScanningRadar
    from .environment import RFEnvironment
    from .metrics import compute_metrics
    from .scenario import Scenario
    from .schedulers import RoundRobinScheduler, run_episode

    rng = np.random.default_rng(seed)
    cases = []
    for T_s, tau_s in [(37, 3), (53, 2), (61, 4), (97, 4), (64, 3), (80, 5)]:
        cases.append(("scanning", {"T_s": T_s, "tau_s": tau_s}))
    for K, h in [(4, 2), (6, 3), (8, 1)]:
        cases.append(("agile", {"K": K, "h": h}))

    out = []
    T = 3000
    for kind, prm in cases:
        firsts, irs = [], []
        for i in range(n_trials):
            if kind == "scanning":
                e = ScanningRadar(band=int(rng.integers(N)), scan_period=prm["T_s"], beam_width=prm["tau_s"],
                                  erp_dbm=110, range_km=20)
            else:
                e = AgileRadar(bands=sorted(rng.choice(N, prm["K"], replace=False).tolist()), hop_dwell=prm["h"],
                               pattern="random", erp_dbm=110, range_km=20)
            env = RFEnvironment(Scenario(n_bands=N, T=T, emitters=[e]), seed=int(rng.integers(1 << 30)))
            env.rx.cfg.pfa = 1e-3
            m = compute_metrics(env, run_episode(env, RoundRobinScheduler(), seed=i, record=False))
            pe = m["per_emitter"][0]
            if pe["time_to_intercept"] is not None:
                firsts.append(pe["time_to_intercept"])
            irs.append(pe["intercepted"] / max(pe["events"], 1))
        sim_t, sim_ir = float(np.mean(firsts)) if firsts else float("inf"), float(np.mean(irs))
        if kind == "scanning":
            an = analytic_periodic(N, 1, prm["T_s"], prm["tau_s"])
            ex = exact_periodic(N, 1, prm["T_s"], prm["tau_s"])
            row = {"case": f"Scanning T_s={prm['T_s']} tau_s={prm['tau_s']}", "model": "phase-lattice (exact)",
                   "classical_time": an["mean_intercept_time"], "pred_time": ex["mean_intercept_time"],
                   "pred_ir": ex["intercept_ratio"], "pred_lockout": ex["p_never"]}
        else:
            an = analytic_agile(N, prm["h"], prm["K"])
            row = {"case": f"Agile K={prm['K']} hop={prm['h']}", "model": "random-hop analytic",
                   "classical_time": an["mean_intercept_time"], "pred_time": an["mean_intercept_time"],
                   "pred_ir": an["intercept_ratio"], "pred_lockout": 0.0}
        row.update({"sim_time": sim_t, "sim_ir": sim_ir, "sim_lockout": 1 - len(firsts) / n_trials,
                    "time_error": abs(row["pred_time"] - sim_t) if np.isfinite(sim_t) else None,
                    "ir_error": abs(row["pred_ir"] - sim_ir)})
        out.append(row)
    ok = [r for r in out if r["time_error"] is not None and r["pred_lockout"] < 0.5]
    return {"rows": out, "n_trials": n_trials,
            "mean_abs_time_error_slots": float(np.mean([r["time_error"] for r in ok])),
            "mean_abs_time_error_pct": float(np.mean([r["time_error"] / r["sim_time"] * 100 for r in ok])),
            "mean_abs_ir_error": float(np.mean([r["ir_error"] for r in out]))}
