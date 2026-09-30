"""FastAPI backend for the Smart Scan ES receiver scheduler.

Run:  python run_server.py   (then open http://127.0.0.1:8000)
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ewscan.environment import RFEnvironment  # noqa: E402
from ewscan.metrics import SUMMARY_KEYS, compute_metrics  # noqa: E402
from ewscan.predictor import PredictorScheduler, load_predictor  # noqa: E402
from ewscan.receiver import ReceiverConfig, ReceiverModel  # noqa: E402
from ewscan.rl import load_dqn  # noqa: E402
from ewscan.scenario import PRESETS, Scenario, preset, random_scenario  # noqa: E402
from ewscan.schedulers import (ModelBasedScheduler, RandomScheduler, RandomSweepScheduler,  # noqa: E402
                               RoundRobinScheduler, ThompsonScheduler, run_episode)
from ewscan import theory  # noqa: E402

MODELS, REPORTS, WEB = ROOT / "models", ROOT / "reports", ROOT / "web"

app = FastAPI(title="Smart Scan - ES Receiver Scheduler")
app.mount("/static", StaticFiles(directory=WEB), name="static")

_predictor = load_predictor(MODELS / "predictor.pt")
_dqn_loaded = (MODELS / "dqn.pt").exists()


def make_scheduler(name: str):
    if name == "round_robin":
        return RoundRobinScheduler()
    if name == "random_sweep":
        return RandomSweepScheduler()
    if name == "random":
        return RandomScheduler()
    if name == "thompson":
        return ThompsonScheduler()
    if name == "model_based":
        return ModelBasedScheduler()
    if name == "gru_predictor":
        if _predictor is None:
            raise HTTPException(400, "GRU predictor not trained yet (python train.py predictor)")
        return PredictorScheduler(_predictor)
    if name == "dqn":
        s = load_dqn(MODELS / "dqn.pt", MODELS / "predictor.pt")
        if s is None:
            raise HTTPException(400, "DQN not trained yet (python train.py rl)")
        return s
    raise HTTPException(400, f"unknown scheduler {name}")


SCHEDULERS = [
    ("round_robin", "Round-robin sweep", "open-loop"),
    ("random_sweep", "Randomised sweep", "open-loop"),
    ("random", "Random dwell", "open-loop"),
    ("thompson", "Thompson bandit", "learning"),
    ("model_based", "Smart scan: model-based", "smart"),
    ("gru_predictor", "Smart scan: GRU predictor", "ml"),
    ("dqn", "Smart scan: RL (DQN)", "ml"),
]


def _available(name):
    return (name != "gru_predictor" or _predictor is not None) and (name != "dqn" or _dqn_loaded)


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.get("/api/info")
def info():
    rx = ReceiverModel(ReceiverConfig())
    return {
        "receiver": rx.summary(),
        "presets": {k: {"description": f().description, "scenario": f().to_dict()} for k, f in PRESETS.items()},
        "schedulers": [{"name": n, "label": l, "group": g, "available": _available(n)} for n, l, g in SCHEDULERS],
    }


class SimRequest(BaseModel):
    preset: str | None = "air_defence"
    scenario: dict | None = None
    random_seed: int | None = None
    seed: int = 1
    schedulers: list[str] = ["round_robin", "model_based"]


def _clean(x):
    if isinstance(x, float):
        return None if not np.isfinite(x) else round(x, 5)
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_clean(v) for v in x]
    return x


@app.post("/api/simulate")
def simulate(req: SimRequest):
    if req.scenario:
        sc = Scenario.from_dict(req.scenario)
    elif req.random_seed is not None:
        sc = random_scenario(np.random.default_rng(req.random_seed))
    else:
        if req.preset not in PRESETS:
            raise HTTPException(400, "unknown preset")
        sc = preset(req.preset)
    if sc.T > 5000 or sc.n_bands > 64:
        raise HTTPException(400, "scenario too large (max 5000 slots, 64 bands)")
    env = RFEnvironment(sc, seed=req.seed)
    emitters = [{"id": i, **e.to_dict(), "threat": e.threat} for i, e in enumerate(sc.emitters)]
    runs = {}
    for name in req.schedulers:
        s = make_scheduler(name)
        t0 = time.time()
        log = run_episode(env, s, seed=req.seed)
        m = compute_metrics(env, log)
        pred = log["pred"]
        runs[name] = {
            "label": s.label,
            "actions": log["actions"].tolist(),
            "detections": log["detections"].astype(int).tolist(),
            "rewards": np.round(log["rewards"], 3).tolist(),
            "pred": None if np.all(np.isnan(pred)) else np.round(np.nan_to_num(pred), 2).tolist(),
            "metrics": m,
            "runtime_s": round(time.time() - t0, 3),
        }
    return _clean({
        "scenario": sc.to_dict(),
        "emitters": emitters,
        "n_bands": sc.n_bands, "T": sc.T,
        "truth": env.truth_grid().tolist(),
        "pd": np.round(env.pd, 2).tolist(),
        "receiver": env.rx.summary(),
        "runs": runs,
    })


def _json(path: Path):
    if not path.exists():
        raise HTTPException(404, f"{path.name} not found - run python evaluate.py")
    return json.loads(path.read_text())


@app.get("/api/benchmark")
def benchmark():
    return _clean(_json(REPORTS / "benchmark.json"))


@app.get("/api/theory/validation")
def theory_validation():
    return _clean(_json(REPORTS / "theory_validation.json"))


@app.get("/api/theory/optimal")
def theory_optimal(T_s: int = 64, tau_s: int = 3, tau_r: int = 1, T_min: int = 16, span: int = 48):
    if not (2 <= T_s <= 400 and 1 <= tau_s <= 50 and 1 <= tau_r <= 10 and 1 <= T_min <= 200 and span <= 120):
        raise HTTPException(400, "parameters out of range")
    return _clean(theory.optimal_revisit(T_s, tau_s, tau_r, T_min, T_min + span))


@app.get("/api/training")
def training():
    import torch
    out = {}
    for name in ("predictor", "dqn"):
        p = MODELS / f"{name}.pt"
        if p.exists():
            out[name] = torch.load(p, map_location="cpu", weights_only=False).get("history", [])
    return _clean(out)


@app.get("/api/metric_keys")
def metric_keys():
    return SUMMARY_KEYS
