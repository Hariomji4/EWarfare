"""Benchmark all schedulers and validate the interception theory.

    python evaluate.py                 # full benchmark -> reports/
    python evaluate.py --n-random 10   # quicker

Outputs
    reports/benchmark.json          metrics (mean/std) per scheduler, random + presets
    reports/theory_validation.json  analytic model vs Monte-Carlo simulation
    reports/*.png                   figures for the presentation
    reports/RESULTS.md              summary tables
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch

from ewscan import theory
from ewscan.environment import RFEnvironment
from ewscan.metrics import SUMMARY_KEYS, compute_metrics
from ewscan.predictor import PredictorScheduler, load_predictor
from ewscan.rl import load_dqn
from ewscan.scenario import PRESETS, preset, random_scenario
from ewscan.schedulers import (ModelBasedScheduler, RandomScheduler, RandomSweepScheduler,
                               RoundRobinScheduler, ThompsonScheduler, run_episode)

ROOT = Path(__file__).parent
REPORTS, MODELS = ROOT / "reports", ROOT / "models"

LABELS = {"round_robin": "Round-robin (open loop)", "random_sweep": "Random sweep (open loop)",
          "random": "Random dwell", "thompson": "Thompson bandit", "model_based": "Smart scan: model-based",
          "gru_predictor": "Smart scan: GRU predictor", "dqn": "Smart scan: RL (DQN)"}
SHORT = {"round_robin": "Round-robin", "random_sweep": "Rand. sweep", "random": "Random", "thompson": "Bandit",
         "model_based": "Model-based", "gru_predictor": "GRU", "dqn": "RL (DQN)"}
NICE = {"pd": "Pd", "pfa": "Pfa", "hit_rate": "Hit rate", "intercept_ratio": "Intercept ratio",
        "threat_weighted_ir": "Threat-wtd IR", "emitters_found": "Emitters found",
        "mean_intercept_time_slots": "Mean intercept time (slots)", "mean_info_age_slots": "Mean info age (slots)",
        "intercept_rate_per_s": "Intercepts / s", "avg_reward": "Avg reward",
        "prediction_accuracy": "Prediction acc.", "all_band_accuracy": "All-band pred. acc.",
        "intercept_time_error_slots": "Intercept-time error (slots)"}


def build_schedulers():
    s = {"round_robin": RoundRobinScheduler, "random_sweep": RandomSweepScheduler, "random": RandomScheduler,
         "thompson": ThompsonScheduler, "model_based": ModelBasedScheduler}
    pred = load_predictor(MODELS / "predictor.pt")
    if pred is not None:
        s["gru_predictor"] = lambda: PredictorScheduler(pred)
    if (MODELS / "dqn.pt").exists():
        s["dqn"] = lambda: load_dqn(MODELS / "dqn.pt", MODELS / "predictor.pt")
    return s


def agg(ms):
    out = {}
    for k in SUMMARY_KEYS:
        v = [m[k] for m in ms if k in m and m[k] is not None]
        if v:
            out[k] = {"mean": float(np.mean(v)), "std": float(np.std(v)), "n": len(v)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-random", type=int, default=30)
    ap.add_argument("--preset-seeds", type=int, default=3)
    ap.add_argument("--theory-trials", type=int, default=150)
    args = ap.parse_args()
    torch.set_num_threads(4)
    REPORTS.mkdir(exist_ok=True)
    scheds = build_schedulers()
    t0 = time.time()

    rng = np.random.default_rng(2026)          # held-out: never used in training
    test = [(random_scenario(rng), 70000 + i) for i in range(args.n_random)]
    res_random = {n: [] for n in scheds}
    for i, (sc, seed) in enumerate(test):
        env = RFEnvironment(sc, seed=seed)
        for n, mk in scheds.items():
            res_random[n].append(compute_metrics(env, run_episode(env, mk(), seed=seed)))
        print(f"random scenario {i + 1}/{len(test)}  ({time.time() - t0:.0f}s)", flush=True)

    res_presets = {}
    for p in PRESETS:
        res_presets[p] = {n: [] for n in scheds}
        for k in range(args.preset_seeds):
            env = RFEnvironment(preset(p), seed=100 + k)
            for n, mk in scheds.items():
                res_presets[p][n].append(compute_metrics(env, run_episode(env, mk(), seed=100 + k)))
        print(f"preset {p} done ({time.time() - t0:.0f}s)", flush=True)

    bench = {
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "n_random": args.n_random, "preset_seeds": args.preset_seeds,
        "schedulers": [{"name": n, "label": LABELS[n]} for n in scheds],
        "metric_names": NICE,
        "random": {n: agg(v) for n, v in res_random.items()},
        "presets": {p: {n: agg(v) for n, v in d.items()} for p, d in res_presets.items()},
    }
    (REPORTS / "benchmark.json").write_text(json.dumps(bench, indent=1))

    print("theory validation ...", flush=True)
    val = theory.validate_against_simulation(args.theory_trials)
    val["optimal_example"] = theory.optimal_revisit(64, 3, 1, 16, 48)
    (REPORTS / "theory_validation.json").write_text(json.dumps(val, indent=1, default=float))

    make_plots(bench, val)
    write_markdown(bench, val)
    print(f"done in {time.time() - t0:.0f}s -> {REPORTS}")


def make_plots(bench, val):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    names = [s["name"] for s in bench["schedulers"]]
    colors = ["#8a8f98", "#a3a9b3", "#c3c7cd", "#d4a24c", "#2f7de1", "#16a37f", "#9b51e0"][:len(names)]
    keys = ["intercept_ratio", "threat_weighted_ir", "emitters_found", "mean_intercept_time_slots",
            "mean_info_age_slots", "avg_reward"]
    fig, axes = plt.subplots(2, 3, figsize=(15, 8))
    for ax, k in zip(axes.ravel(), keys):
        m = [bench["random"][n].get(k, {}).get("mean", np.nan) for n in names]
        s = [bench["random"][n].get(k, {}).get("std", 0) / np.sqrt(bench["n_random"]) for n in names]
        ax.bar(range(len(names)), m, yerr=s, color=colors, capsize=3)
        ax.set_xticks(range(len(names)))
        ax.set_xticklabels([SHORT[n] for n in names], fontsize=8, rotation=30, ha="right")
        ax.set_title(NICE[k] + (" (lower is better)" if "time" in k or "age" in k else ""), fontsize=10)
        ax.grid(axis="y", alpha=0.3)
    fig.suptitle(f"Scheduler benchmark on {bench['n_random']} unseen random scenarios (mean ± s.e.)")
    fig.tight_layout()
    fig.savefig(REPORTS / "benchmark.png", dpi=130)
    plt.close(fig)

    ex = val["optimal_example"]
    c = ex["curve"]
    fig, ax = plt.subplots(figsize=(10, 4.5))
    Tr = [r["T_r"] for r in c]
    worst = [r["worst"] if np.isfinite(r["worst"]) else np.nan for r in c]
    ax.plot(Tr, [r["mean"] for r in c], "o-", label="mean intercept time (exact)")
    ax.plot(Tr, worst, "s-", label="worst-case intercept time (exact)")
    for r in c:
        if not r["guaranteed"]:
            ax.axvspan(r["T_r"] - 0.5, r["T_r"] + 0.5, color="red", alpha=0.12)
    if ex["best"]:
        ax.axvline(ex["best"]["T_r"], color="green", ls="--", label=f"optimal T_r = {ex['best']['T_r']}")
    ax.set_xlabel("receiver revisit period T_r (slots)")
    ax.set_ylabel("slots")
    ax.set_title(f"Periodic intercept design: emitter T_s={ex['T_s']}, beam {ex['tau_s']} slots "
                 "(red = lock-out: some phases never intercepted)")
    ax.legend()
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(REPORTS / "periodic_intercept.png", dpi=130)
    plt.close(fig)

    rows = val["rows"]
    fig, ax = plt.subplots(1, 2, figsize=(13, 4.5))
    x = np.arange(len(rows))
    ax[0].bar(x - 0.2, [r["pred_time"] for r in rows], 0.4, label="predicted (model)")
    ax[0].bar(x + 0.2, [r["sim_time"] for r in rows], 0.4, label="simulated")
    ax[1].bar(x - 0.2, [r["pred_ir"] for r in rows], 0.4, label="predicted (model)")
    ax[1].bar(x + 0.2, [r["sim_ir"] for r in rows], 0.4, label="simulated")
    for a, t in zip(ax, ["Mean intercept time (slots)", "Interception ratio"]):
        a.set_xticks(x)
        a.set_xticklabels([r["case"].replace(" ", "\n", 1) for r in rows], fontsize=7)
        a.set_title(t)
        a.legend()
        a.grid(axis="y", alpha=0.3)
    fig.suptitle("Intercept prediction model vs simulation (round-robin receiver)")
    fig.tight_layout()
    fig.savefig(REPORTS / "theory_validation.png", dpi=130)
    plt.close(fig)

    for name in ("predictor", "dqn"):
        p = MODELS / f"{name}.pt"
        if not p.exists():
            continue
        h = torch.load(p, map_location="cpu", weights_only=False).get("history", [])
        if not h:
            continue
        fig, ax = plt.subplots(figsize=(8, 4))
        if name == "predictor":
            ep = [r["epoch"] for r in h]
            ax.plot(ep, [r["train_loss"] for r in h], label="train loss")
            ax.plot(ep, [r["val_loss"] for r in h], label="val loss")
            ax2 = ax.twinx()
            ax2.plot(ep, [r["balanced_acc_now"] for r in h], "g--", label="val balanced acc")
            ax2.legend(loc="center right")
            ax.set_xlabel("epoch")
        else:
            st = [r["step"] for r in h]
            ax.plot(st, [r["val_reward"] for r in h], "o-", label="validation avg reward")
            ax.set_xlabel("environment steps")
        ax.legend(loc="upper left")
        ax.grid(alpha=0.3)
        ax.set_title(f"Training curve: {name}")
        fig.tight_layout()
        fig.savefig(REPORTS / f"training_{name}.png", dpi=130)
        plt.close(fig)


def write_markdown(bench, val):
    names = [s["name"] for s in bench["schedulers"]]
    keys = ["intercept_ratio", "threat_weighted_ir", "emitters_found", "mean_intercept_time_slots",
            "mean_info_age_slots", "hit_rate", "pd", "pfa", "avg_reward", "prediction_accuracy",
            "intercept_time_error_slots"]

    def cell(d, k):
        if k not in d:
            return "-"
        return f"{d[k]['mean']:.3f}" if abs(d[k]["mean"]) < 10 else f"{d[k]['mean']:.1f}"

    L = [f"# Results ({bench['generated']})", "",
         f"## Unseen random scenarios (n={bench['n_random']})", "",
         "| Scheduler | " + " | ".join(NICE[k] for k in keys) + " |",
         "|---|" + "---|" * len(keys)]
    for n in names:
        L.append(f"| {LABELS[n]} | " + " | ".join(cell(bench["random"][n], k) for k in keys) + " |")
    for p, d in bench["presets"].items():
        L += ["", f"## Preset: {p} ({bench['preset_seeds']} seeds)", "",
              "| Scheduler | " + " | ".join(NICE[k] for k in keys[:6] + ["avg_reward"]) + " |",
              "|---|" + "---|" * 7]
        for n in names:
            L.append(f"| {LABELS[n]} | " + " | ".join(cell(d[n], k) for k in keys[:6] + ["avg_reward"]) + " |")
    L += ["", "## Intercept prediction model vs simulation", "",
          "| Case | Model | Pred. time | Sim. time | Pred. IR | Sim. IR | Pred. lock-out | Sim. lock-out |",
          "|---|---|---|---|---|---|---|---|"]
    for r in val["rows"]:
        L.append(f"| {r['case']} | {r['model']} | {r['pred_time']:.1f} | {r['sim_time']:.1f} | {r['pred_ir']:.3f} | "
                 f"{r['sim_ir']:.3f} | {r['pred_lockout']:.2f} | {r['sim_lockout']:.2f} |")
    L += ["", f"Mean absolute intercept-time error: {val['mean_abs_time_error_slots']:.1f} slots "
              f"({val['mean_abs_time_error_pct']:.1f} %); mean absolute IR error {val['mean_abs_ir_error']:.3f}."]
    (REPORTS / "RESULTS.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
