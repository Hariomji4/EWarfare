"""Reinforcement-learning scheduler (Double DQN, per-band shared Q network).

MDP
    state    per-band features from the ObservationTracker (time since visit /
             hit, occupancy, scan-period & phase prediction, SNR, revisit value),
             the GRU predictor's P(active), and the model-based smart-scan
             recommendation + acquisition flag; plus global episode features.
    action   the band to dwell on in this slot.
    reward   from the environment: threat-weighted value of a true intercept
             (large bonus for a first intercept of a new emitter, revisit value
             for re-intercepts), false-alarm penalty and a per-dwell time cost.

Q network: every band is scored by the same MLP (permutation-equivariant, so it
generalises to any emitter laydown) with a mean-pooled context of all bands:
    h_b = f(x_b);  c = mean_b h_b;  Q_b = g([h_b, c, global])

Training: off-policy with replay; the buffer is warm-started with the
model-based scheduler (demonstrations) and exploration is epsilon-greedy.
Scenarios are freshly randomised every episode - no prior intelligence.
"""
from __future__ import annotations

import copy
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from .environment import RFEnvironment
from .predictor import OnlinePredictor, load_predictor, median_first_activity
from .scenario import random_scenario
from .schedulers import ModelBasedScheduler, Scheduler, run_episode
from .tracker import N_FEATURES

F_BAND = N_FEATURES + 3     # + GRU p(now), GRU max p(next 4), model-based choice ... see _state
F_GLOBAL = 3


class QNet(nn.Module):
    def __init__(self, f_band=F_BAND, f_global=F_GLOBAL, hidden=64):
        super().__init__()
        self.enc = nn.Sequential(nn.Linear(f_band, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU())
        self.head = nn.Sequential(nn.Linear(2 * hidden + f_global, hidden), nn.ReLU(), nn.Linear(hidden, 1))

    def forward(self, xb, xg):
        # xb (B, N, F), xg (B, G) -> Q (B, N)
        h = self.enc(xb)
        c = h.mean(dim=1, keepdim=True).expand_as(h)
        g = xg[:, None, :].expand(-1, h.shape[1], -1)
        return self.head(torch.cat([h, c, g], dim=-1)).squeeze(-1)


class _Agent:
    """Shared state construction for training and inference."""

    def __init__(self, predictor=None):
        self.mb = ModelBasedScheduler()
        self.online = OnlinePredictor(predictor) if predictor is not None else None

    def reset(self, N, T, rng, noise_floor):
        self.N = N
        self.mb.reset(N, T, rng, noise_floor)
        if self.online:
            self.online.reset()

    def state(self, t):
        tr = self.mb.tracker
        rec = self.mb.select(t)
        if self.online:
            P = self.online.step(t, tr)
            p_now, p_soon = P[:, 0], P[:, :4].max(axis=1)
        else:
            p_now = tr.p_active(t)
            p_soon = p_now
        xb = tr.features(t, p_extra=p_now)
        choice = np.zeros(self.N, dtype=np.float32)
        choice[rec] = 1.0
        watch = np.zeros(self.N, dtype=np.float32)
        if self.mb.watch_band >= 0:
            watch[self.mb.watch_band] = 1.0
        xb = np.concatenate([xb, p_soon[:, None], choice[:, None], watch[:, None]], axis=1)
        return xb.astype(np.float32), tr.global_features(t), rec

    def update(self, t, band, det, power):
        self.mb.update(t, band, det, power)
        if self.online:
            self.online.observe(band, det)

    def p_now(self, t):
        if self.online:
            return self.online.step(t, self.mb.tracker)[:, 0]
        return self.mb.tracker.p_active(t)


class DQNScheduler(Scheduler):
    name, label, closed_loop = "dqn", "Smart scan - RL (DQN)", True

    def __init__(self, qnet: QNet, predictor=None, max_revisit: int | None = 32):
        """max_revisit: coverage shield - any band left unvisited for longer than
        this many slots is visited next, bounding the search revisit time so
        new / pop-up emitters keep being found (None disables the shield)."""
        self.q = qnet.eval()
        self.agent = _Agent(predictor)
        self.max_revisit = max_revisit

    def reset(self, n_bands, T, rng, noise_floor=-74.0):
        super().reset(n_bands, T, rng, noise_floor)
        self.agent.reset(n_bands, T, rng, noise_floor)

    @torch.no_grad()
    def select(self, t):
        xb, xg, _ = self.agent.state(t)
        if self.max_revisit is not None:
            lv = self.agent.mb.tracker.last_visit
            stale = np.where(lv < 0, t + 1, t - lv)
            if stale.max() > self.max_revisit:
                return int(self.rng.choice(np.flatnonzero(stale == stale.max())))
        q = self.q(torch.from_numpy(xb)[None], torch.from_numpy(xg)[None])[0]
        return int(q.argmax())

    def update(self, t, band, detected, power):
        self.agent.update(t, band, detected, power)

    def predictions(self, t):
        return self.agent.p_now(t)

    def time_to_next(self, t):
        if self.agent.online:
            return median_first_activity(self.agent.online.step(t, self.agent.mb.tracker))
        return self.agent.mb.tracker.time_to_next(t)


def load_dqn(path="models/dqn.pt", predictor_path="models/predictor.pt"):
    path = Path(path)
    if not path.exists():
        return None
    ck = torch.load(path, map_location="cpu", weights_only=False)
    q = QNet()
    q.load_state_dict(ck["state_dict"])
    pred = load_predictor(predictor_path) if ck.get("uses_predictor") else None
    return DQNScheduler(q, pred)


# ====================================================================== training
class Replay:
    def __init__(self, cap, N):
        self.cap, self.i, self.full = cap, 0, False
        self.xb = np.zeros((cap, N, F_BAND), np.float32)
        self.xg = np.zeros((cap, F_GLOBAL), np.float32)
        self.a = np.zeros(cap, np.int64)
        self.r = np.zeros(cap, np.float32)
        self.xb2 = np.zeros((cap, N, F_BAND), np.float32)
        self.xg2 = np.zeros((cap, F_GLOBAL), np.float32)
        self.d = np.zeros(cap, np.float32)

    def add(self, xb, xg, a, r, xb2, xg2, d):
        i = self.i
        self.xb[i], self.xg[i], self.a[i], self.r[i] = xb, xg, a, r
        self.xb2[i], self.xg2[i], self.d[i] = xb2, xg2, d
        self.i = (i + 1) % self.cap
        self.full |= self.i == 0

    def __len__(self):
        return self.cap if self.full else self.i

    def sample(self, n, rng):
        idx = rng.integers(0, len(self), n)
        f = lambda x: torch.from_numpy(x[idx])
        return f(self.xb), f(self.xg), f(self.a), f(self.r), f(self.xb2), f(self.xg2), f(self.d)


def _validate(q, predictor, scenarios, seeds):
    from .metrics import compute_metrics
    s = DQNScheduler(copy.deepcopy(q), predictor)
    R, IR = [], []
    for sc, sd in zip(scenarios, seeds):
        env = RFEnvironment(sc, seed=sd)
        m = compute_metrics(env, run_episode(env, s, seed=sd, record=False))
        R.append(m["avg_reward"]); IR.append(m["intercept_ratio"])
    return float(np.mean(R)), float(np.mean(IR))


def train_dqn(out_path="models/dqn.pt", total_steps=300_000, predictor_path="models/predictor.pt",
              n_bands=16, T=1000, gamma=0.95, lr=5e-4, batch=128, buffer=150_000, demo_steps=30_000,
              train_every=4, eps_start=0.3, eps_end=0.02, seed=0, eval_every=25_000, log=print):
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    predictor = load_predictor(predictor_path)
    log(f"[dqn] predictor features: {'GRU' if predictor is not None else 'tracker only'}")
    q = QNet()
    q_tgt = copy.deepcopy(q)
    opt = torch.optim.Adam(q.parameters(), lr=lr)
    rb = Replay(buffer, n_bands)
    agent = _Agent(predictor)

    vrng = np.random.default_rng(424242)
    val_sc = [random_scenario(vrng, n_bands, T) for _ in range(10)]
    val_seeds = list(range(9000, 9010))
    mb_R, mb_IR = [], []
    from .metrics import compute_metrics
    for sc, sd in zip(val_sc, val_seeds):
        env = RFEnvironment(sc, seed=sd)
        m = compute_metrics(env, run_episode(env, ModelBasedScheduler(), seed=sd, record=False))
        mb_R.append(m["avg_reward"]); mb_IR.append(m["intercept_ratio"])
    log(f"[dqn] reference model-based on validation: reward {np.mean(mb_R):.4f} IR {np.mean(mb_IR):.3f}")

    best, history, step, t0, ep = -1e9, [], 0, time.time(), 0
    losses = []
    while step < total_steps:
        env = RFEnvironment(random_scenario(rng, n_bands, T), seed=int(rng.integers(1 << 30)))
        env.reset()
        agent.reset(n_bands, T, rng, env.rx.noise_floor_dbm)
        demo = step < demo_steps
        xb, xg, rec = agent.state(0)
        ep_r = 0.0
        while not env.done:
            t = env.t
            frac = min(1.0, max(0, step - demo_steps) / (0.5 * (total_steps - demo_steps)))
            eps = eps_start + frac * (eps_end - eps_start)
            if demo:
                a = rec if rng.random() > 0.2 else int(rng.integers(n_bands))
            elif rng.random() < eps:
                a = rec if rng.random() < 0.5 else int(rng.integers(n_bands))
            else:
                with torch.no_grad():
                    a = int(q(torch.from_numpy(xb)[None], torch.from_numpy(xg)[None])[0].argmax())
            obs, r, done, _ = env.step(a)
            agent.update(t, a, obs["detected"], obs["power_dbm"])
            ep_r += r
            if not done:
                xb2, xg2, rec = agent.state(env.t)
            else:
                xb2, xg2 = xb, xg
            rb.add(xb, xg, a, r, xb2, xg2, float(done))
            xb, xg = xb2, xg2
            step += 1

            if len(rb) >= 5000 and step % train_every == 0:
                b_xb, b_xg, b_a, b_r, b_xb2, b_xg2, b_d = rb.sample(batch, rng)
                with torch.no_grad():
                    a2 = q(b_xb2, b_xg2).argmax(1, keepdim=True)
                    tgt = b_r + gamma * (1 - b_d) * q_tgt(b_xb2, b_xg2).gather(1, a2).squeeze(1)
                qa = q(b_xb, b_xg).gather(1, b_a[:, None]).squeeze(1)
                loss = nn.functional.smooth_l1_loss(qa, tgt)
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(q.parameters(), 10.0)
                opt.step()
                losses.append(loss.item())
                with torch.no_grad():
                    for p, pt in zip(q.parameters(), q_tgt.parameters()):
                        pt.mul_(0.995).add_(0.005 * p)

            if step % eval_every == 0:
                vr, vir = _validate(q, predictor, val_sc, val_seeds)
                history.append({"step": step, "val_reward": vr, "val_ir": vir,
                                "loss": float(np.mean(losses[-2000:])) if losses else None})
                tag = ""
                if vr > best:
                    best = vr
                    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
                    torch.save({"state_dict": q.state_dict(), "uses_predictor": predictor is not None,
                                "history": history}, out_path)
                    tag = "  * saved"
                log(f"[dqn] step {step:7d} eps {eps:.3f} loss {history[-1]['loss'] or 0:.4f} "
                    f"val reward {vr:.4f} (model-based {np.mean(mb_R):.4f}) IR {vir:.3f} "
                    f"({time.time() - t0:.0f}s){tag}")
        ep += 1
    ck = torch.load(out_path, map_location="cpu", weights_only=False)
    ck["history"] = history
    torch.save(ck, out_path)
    return {"best_val_reward": best, "model_based_val_reward": float(np.mean(mb_R)), "episodes": ep}
