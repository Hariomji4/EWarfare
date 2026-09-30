"""GRU activity predictor - supervised learning from hits and misses.

Input at slot t (what the receiver saw at slot t-1):
    one-hot of the band it dwelt on  (N)
    detection flag placed in that band (N)
    tracker phase-model probability for every band (N)   (engineered prior)
Output at slot t: logits for  active[b, t + h],  b < N,  h < H
    i.e. for every band, the probability it is transmitting now and in each of
    the next H-1 slots. From this we get
      * P(active now)              -> activity prediction ('% correct predictions')
      * first h with P > 0.5       -> predicted intercept time per band

Training data: episodes of random scenarios (no prior intelligence), driven by a
mix of behaviour policies; labels are the simulator's ground truth.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from .environment import RFEnvironment
from .scenario import random_scenario
from .schedulers import (ModelBasedScheduler, RandomScheduler, RandomSweepScheduler,
                         RoundRobinScheduler, Scheduler, TrackerScheduler)

H_DEFAULT = 64


class ActivityPredictor(nn.Module):
    """Residual design: logits = alpha_h * logit(tracker prior) + beta_h + GRU correction.
    The network starts from the engineered phase model and learns what it misses
    (hop sequences, cross-band structure, burst statistics, longer-range timing)."""

    def __init__(self, n_bands: int = 16, horizon: int = H_DEFAULT, hidden: int = 160):
        super().__init__()
        self.N, self.H = n_bands, horizon
        self.inp = nn.Sequential(nn.Linear(3 * n_bands, hidden), nn.LayerNorm(hidden), nn.ReLU())
        self.gru = nn.GRU(hidden, hidden, batch_first=True)
        self.out = nn.Sequential(nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, n_bands * horizon))
        nn.init.zeros_(self.out[-1].weight)
        nn.init.zeros_(self.out[-1].bias)
        self.alpha = nn.Parameter(torch.ones(horizon))
        self.beta = nn.Parameter(torch.zeros(horizon))

    def forward(self, x, h=None):
        z, h = self.gru(self.inp(x), h)
        y = self.out(z)
        y = y.view(*y.shape[:-1], self.N, self.H)
        prior = torch.logit(x[..., 2 * self.N:].clamp(1e-3, 1 - 1e-3))
        return y + prior[..., None] * self.alpha + self.beta, h


# ------------------------------------------------------------------ data
class _Behaviour(Scheduler):
    """Mixture behaviour policy with epsilon-random dwells for data diversity."""

    def __init__(self, base: Scheduler, eps: float):
        self.base, self.eps = base, eps

    def reset(self, *a, **k):
        super().reset(*a, **k)
        self.base.reset(*a, **k)

    def select(self, t):
        b = self.base.select(t)
        return int(self.rng.integers(self.N)) if self.rng.random() < self.eps else b

    def update(self, *a):
        self.base.update(*a)


def rollout_features(env: RFEnvironment, sched: Scheduler, rng: np.random.Generator):
    """Run an episode; return model inputs X (T, 3N) and truth active (N, T)."""
    from .tracker import ObservationTracker
    env.reset()
    sched.reset(env.N, env.T, rng, env.rx.noise_floor_dbm)
    tr = ObservationTracker(env.N, env.T, noise_floor_dbm=env.rx.noise_floor_dbm)
    N, T = env.N, env.T
    X = np.zeros((T, 3 * N), dtype=np.float32)
    prev = None
    while not env.done:
        t = env.t
        if prev is not None:
            X[t, prev[0]] = 1.0
            X[t, N + prev[0]] = float(prev[1])
        X[t, 2 * N:] = tr.p_active(t)
        b = sched.select(t)
        obs, *_ = env.step(b)
        sched.update(t, b, obs["detected"], obs["power_dbm"])
        tr.update(t, b, obs["detected"], obs["power_dbm"])
        prev = (b, obs["detected"])
    return X, env.active.copy()


def make_dataset(n_episodes: int, seed: int = 0, n_bands: int = 16, T: int = 1000):
    rng = np.random.default_rng(seed)
    Xs, As = [], []
    for i in range(n_episodes):
        sc = random_scenario(rng, n_bands, T)
        env = RFEnvironment(sc, seed=int(rng.integers(1 << 30)))
        u = rng.random()
        base = (ModelBasedScheduler() if u < 0.5 else RandomSweepScheduler() if u < 0.7
                else RoundRobinScheduler() if u < 0.85 else RandomScheduler())
        X, A = rollout_features(env, _Behaviour(base, eps=float(rng.uniform(0, 0.2))), rng)
        Xs.append(X); As.append(A)
    return np.stack(Xs), np.stack(As)


def horizon_labels(A: torch.Tensor, H: int):
    """A (B, N, T) bool -> Y (B, T, N, H) and validity mask (B, T, 1, H)."""
    B, N, T = A.shape
    pad = torch.cat([A.float(), torch.zeros(B, N, H)], dim=2)
    Y = pad.unfold(2, H, 1)[:, :, :T, :].permute(0, 2, 1, 3)         # (B, T, N, H)
    valid = (torch.arange(T)[:, None] + torch.arange(H)[None, :]) < T  # (T, H)
    return Y, valid[None, :, None, :].float()


# ------------------------------------------------------------------ training
def train_predictor(out_path: str | Path = "models/predictor.pt", n_train: int = 400, n_val: int = 40,
                    epochs: int = 12, batch: int = 32, lr: float = 2e-3, seed: int = 0,
                    iters_per_epoch: int = 150, crop: int = 160,
                    log=print) -> dict:
    torch.manual_seed(seed)
    t0 = time.time()
    cache = Path(out_path).parent / f"predictor_data_{n_train}_{n_val}_{seed}.npz"
    if cache.exists():
        d = np.load(cache)
        Xtr, Atr, Xva, Ava = d["Xtr"], d["Atr"], d["Xva"], d["Ava"]
    else:
        log(f"[predictor] generating {n_train}+{n_val} training episodes ...")
        Xtr, Atr = make_dataset(n_train, seed=seed)
        Xva, Ava = make_dataset(n_val, seed=seed + 999)
        np.savez_compressed(cache, Xtr=Xtr, Atr=Atr, Xva=Xva, Ava=Ava)
    log(f"[predictor] data ready in {time.time() - t0:.0f}s  X={Xtr.shape}")
    N, T = Atr.shape[1], Atr.shape[2]
    model = ActivityPredictor(N, H_DEFAULT)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    total = epochs * iters_per_epoch
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=total, pct_start=0.1)
    Xtr_t, Atr_t = torch.from_numpy(Xtr), torch.from_numpy(Atr)
    Xva_t, Ava_t = torch.from_numpy(Xva), torch.from_numpy(Ava)
    # mild up-weighting of the minority 'active' class (~12% of band-slots) and
    # emphasis on near-term horizons, which drive scheduling decisions
    bce = nn.BCEWithLogitsLoss(reduction="none", pos_weight=torch.tensor(1.5))
    hw = 1.0 / (1.0 + torch.arange(H_DEFAULT) / 8.0)
    hw = (hw / hw.mean()).view(1, 1, 1, -1)
    g = torch.Generator().manual_seed(seed)
    history = []
    for ep in range(epochs):
        model.train()
        tot = 0.0
        for _ in range(iters_per_epoch):
            idx = torch.randint(0, len(Xtr_t), (batch,), generator=g)
            s0 = int(torch.randint(0, T - crop + 1, (1,), generator=g))
            logits, _ = model(Xtr_t[idx, s0:s0 + crop])
            Y, valid = horizon_labels(Atr_t[idx, :, s0:s0 + crop + H_DEFAULT], H_DEFAULT)
            Y, valid = Y[:, :crop], valid[:, :crop]
            w = valid * hw
            loss = (bce(logits, Y) * w).sum() / w.expand_as(Y).sum()
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step()
            tot += loss.item()
        va = evaluate_predictor(model, Xva_t, Ava_t)
        va["epoch"], va["train_loss"] = ep + 1, tot / iters_per_epoch
        history.append(va)
        log(f"[predictor] epoch {ep + 1:2d}/{epochs} train {va['train_loss']:.4f} val {va['val_loss']:.4f} "
            f"acc_now {va['acc_now']:.4f} bal_acc {va['balanced_acc_now']:.4f} "
            f"ttn_mae {va['ttn_mae']:.2f}  ({time.time() - t0:.0f}s)")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "n_bands": N, "horizon": H_DEFAULT,
                "history": history}, out_path)
    log(f"[predictor] saved -> {out_path}")
    return history[-1]


@torch.no_grad()
def evaluate_predictor(model, X, A) -> dict:
    model.eval()
    logits, _ = model(X)
    H = model.H
    Y, valid = horizon_labels(A, H)
    loss = (nn.functional.binary_cross_entropy_with_logits(logits, Y, reduction="none") * valid).sum() \
        / valid.expand_as(Y).sum()
    p = torch.sigmoid(logits)
    now_p, now_y = p[..., 0] > 0.5, Y[..., 0] > 0.5
    acc = (now_p == now_y).float().mean().item()
    tpr = (now_p & now_y).sum().item() / max(now_y.sum().item(), 1)
    tnr = (~now_p & ~now_y).sum().item() / max((~now_y).sum().item(), 1)
    # intercept-time prediction: first h with p>0.5 vs first h truly active
    pred_t = _first_true(p > 0.5, H)
    true_t = _first_true(Y > 0.5, H)
    ok = true_t < H
    mae = (pred_t[ok] - true_t[ok]).abs().float().mean().item()
    return {"val_loss": loss.item(), "acc_now": acc, "balanced_acc_now": 0.5 * (tpr + tnr), "ttn_mae": mae}


def _first_true(m: torch.Tensor, H: int) -> torch.Tensor:
    idx = torch.arange(H).expand_as(m)
    return torch.where(m, idx, torch.full_like(idx, H)).min(dim=-1).values


def median_first_activity(P: np.ndarray) -> np.ndarray:
    """Predicted intercept time per band: median of the first-activity time,
    i.e. the first h where P(active at least once in [0, h]) >= 0.5."""
    surv = np.cumprod(1.0 - P, axis=-1)
    hit = surv <= 0.5
    return np.where(hit.any(axis=-1), hit.argmax(axis=-1), P.shape[-1])


def load_predictor(path: str | Path = "models/predictor.pt") -> ActivityPredictor | None:
    path = Path(path)
    if not path.exists():
        return None
    ck = torch.load(path, map_location="cpu", weights_only=False)
    m = ActivityPredictor(ck["n_bands"], ck["horizon"])
    m.load_state_dict(ck["state_dict"])
    m.eval()
    return m


# ------------------------------------------------------------------ online use
class OnlinePredictor:
    """Steps the GRU one slot at a time alongside a tracker."""

    def __init__(self, model: ActivityPredictor):
        self.model = model
        self.N, self.H = model.N, model.H

    def reset(self):
        self.h = None
        self.prev = None
        self.probs = np.full((self.N, self.H), 0.2, dtype=np.float32)
        self._t = -1

    @torch.no_grad()
    def step(self, t: int, tracker) -> np.ndarray:
        """Call once per slot before selecting; returns P(active) (N, H)."""
        if t == self._t:
            return self.probs
        x = np.zeros(3 * self.N, dtype=np.float32)
        if self.prev is not None:
            x[self.prev[0]] = 1.0
            x[self.N + self.prev[0]] = float(self.prev[1])
        x[2 * self.N:] = tracker.p_active(t)
        y, self.h = self.model(torch.from_numpy(x)[None, None], self.h)
        self.probs = torch.sigmoid(y[0, 0]).numpy()
        self._t = t
        return self.probs

    def observe(self, band: int, detected: bool):
        self.prev = (band, detected)


class PredictorScheduler(TrackerScheduler):
    """Greedy scheduler driven by the GRU predictor:
    score = P_gru(active now) * revisit value + coverage bonus."""
    name, label = "gru_predictor", "Smart scan - GRU predictor"

    def __init__(self, model: ActivityPredictor, revisit_target: int = 30, c_cover: float = 0.5):
        self.online = OnlinePredictor(model)
        self.R, self.c = revisit_target, c_cover

    def reset(self, *a, **k):
        super().reset(*a, **k)
        self.online.reset()

    def select(self, t):
        tr = self.tracker
        p = self.online.step(t, tr)[:, 0]
        value = np.where(tr.last_det < 0, 1.0, np.minimum(1.0, (t - tr.last_det) / self.R))
        cover = np.where(tr.last_visit < 0, 2.0, np.minimum(1.0, (t - tr.last_visit) / (2 * self.N)))
        score = p * value + self.c * cover + 1e-3 * self.rng.random(self.N)
        return int(np.argmax(score))

    def update(self, t, band, detected, power):
        super().update(t, band, detected, power)
        self.online.observe(band, detected)

    def predictions(self, t):
        return self.online.step(t, self.tracker)[:, 0]

    def time_to_next(self, t):
        return median_first_activity(self.online.step(t, self.tracker))
