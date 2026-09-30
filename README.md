# Smart Scan: ML-based ES Receiver Scheduler

**Problem statement:** Development of a Smart Scan Strategy for Electronic Warfare in the absence of prior reliable intelligence of emitters and their operating characteristics.

An Electronic Support (ES) receiver whose instantaneous bandwidth (1 GHz) is an order of magnitude narrower than the spectrum it must cover (2–18 GHz, 16 bands) has to decide, **every dwell, which band to listen to**. Open-loop sweeps planned from pre-mission data waste dwells on non-threatening emitters and can *lock out* periodic emitters entirely. This software learns closed-loop scan schedules from its own **hits and misses**, and predicts intercept time and interception ratio.

## Quick start

```bash
pip install -r requirements.txt
python train.py predictor      # supervised GRU activity predictor  (~15 min on CPU)
python train.py rl             # Double-DQN scheduler                (~30-60 min on CPU)
python evaluate.py             # benchmark + theory validation -> reports/
python run_server.py           # dashboard at http://127.0.0.1:8000
```

The dashboard also works before training. The learned schedulers simply show as "not trained".

## Architecture

```
ewscan/
  receiver.py     Receiver system model: noise floor, energy detector Pd(SNR) at design Pfa, sensitivity
  emitters.py     Scanning radar, tracking radar, frequency-agile radar (cyclic/random), comms, beacon
  scenario.py     Presets + randomised laydowns (no prior intelligence / domain randomisation)
  environment.py  Simulated RF environment: ground truth per band per slot, pre-drawn detection outcomes, reward
  tracker.py      Receiver memory: scan-period estimation (difference histogram), phase-folded activity model
  schedulers.py   Round-robin / randomised sweep / random (open loop), Thompson bandit, model-based smart scan
  predictor.py    GRU activity predictor (supervised, trained on hit/miss sequences) + GRU-driven scheduler
  rl.py           Double-DQN scheduler with a per-band shared Q-network
  theory.py       Intercept-time / interception-ratio model, lock-out analysis, optimal revisit period
  metrics.py      Figures of merit
server/app.py     FastAPI backend       web/  dashboard (live waterfall, benchmark, theory, training, editor)
train.py          training CLI           evaluate.py  benchmark + report generation
```

### Simulated RF environment (truth information)
Each emitter renders a timeline of `(band, received power)` for every slot. A scanning radar is visible only while its main beam sweeps over us. An agile radar is visible in whichever band it has hopped to. For each band and slot the environment stores whether it is transmitting, the strongest emitter, the received power and the receiver's Pd. Detection outcomes are pre-drawn, so every strategy faces the same noise realisation.

### Receiver model
Noise floor = −174 dBm/Hz + 10·log₁₀(B) + NF. Square-law energy detector integrating M samples: the threshold comes from the χ²(2M) tail at the design Pfa, and Pd comes from the non-central χ²(2M, 2M·SNR) tail. Sensitivity is the received power needed for Pd = 0.9 (−72 dBm by default).

### Schedulers
| Scheduler | Type | Idea |
|---|---|---|
| Round-robin sweep | open loop | Fixed sweep (the current practice) |
| Randomised sweep | open loop | New random order every cycle, which breaks synchronisation lock-out |
| Thompson bandit | learning | Discounted Beta posterior on P(hit) per band |
| **Model-based smart scan** | closed loop | Coverage sweep, then **period acquisition** (watch a band after a transient hit until the next beam; this measures T_s), then **timed interrupts** at predicted illuminations. Also skips continuous emitters it has just intercepted |
| **GRU predictor** | supervised ML | Predicts P(active) for every band over the next 64 slots from the hit/miss stream (residual over the phase model) |
| **DQN** | reinforcement learning | Double DQN. The state holds tracker features, GRU forecasts and the model-based recommendation. The reward is threat-weighted intercepts, a new-emitter bonus, revisit value, a false-alarm penalty and a dwell cost |

### Periodic-scan intercept (theory.py)
A look and an illumination coincide when their relative offset lies inside a window w = τ_r + τ_s − 1. The offset advances by T_r mod T_s per look, so only a lattice of step g = gcd(T_r, T_s) is ever visited.

* Intercept is **guaranteed** for every phase **iff gcd(T_r, T_s) ≤ w**. Otherwise some phase alignments are *never* intercepted (lock-out). Example: a 16-band sweep against a 64-slot scanner with a 3-slot beam locks out 81% of alignments.
* **Optimal revisit period:** choose T_r so the phase slips across the scan in steps close to w (vernier), minimising the worst-case intercept time. For an unknown T_s, measure it first (acquisition), then revisit exactly at predicted illuminations (tracking).
* The exact phase-lattice model predicts mean intercept time and interception ratio. It is validated against Monte-Carlo simulation in `reports/theory_validation.json`.

### Figures of merit
Pd, Pfa, sensitivity, interception ratio (plain and threat-weighted), fraction of emitters found, mean time to first intercept, mean information age, average intercept rate, hit rate, average reward (cost function), % correct predictions (dwelt band and all bands), and average intercept-time prediction error.

## Results (30 unseen random scenarios, `reports/RESULTS.md`)

| Scheduler | Intercept ratio | Threat-wtd IR | Emitters found | Info age (slots) | Avg reward | Intercept-time pred. error |
|---|---|---|---|---|---|---|
| Round-robin (open loop) | 0.221 | 0.216 | 0.901 | 144.8 | 0.118 | – |
| Random sweep (open loop) | 0.213 | 0.209 | 0.957 | 132.5 | 0.119 | – |
| Thompson bandit | 0.178 | 0.171 | 0.881 | 185.9 | 0.100 | – |
| Smart scan: model-based | 0.317 | 0.320 | 0.913 | 138.7 | 0.121 | 32.5 slots |
| Smart scan: GRU predictor | 0.358 | 0.363 | 0.940 | 136.5 | 0.127 | 12.4 slots |
| **Smart scan: RL (DQN)** | **0.394** | **0.400** | 0.923 | **123.6** | **0.133** | **12.3 slots** |

* The DQN intercepts **78% more transmission events** than the open-loop sweep (85% more threat-weighted), with 15% fresher information on every emitter.
* Intercept prediction model vs simulation: mean intercept-time error 12.8%, interception-ratio error 0.007, lock-out predicted 0.81 vs 0.79 simulated.
* **Trade-off:** for *first discovery* of a new emitter, the randomised open-loop sweep is still fastest (151 vs 204 slots for the DQN), because it spends every dwell searching. The DQN's coverage shield (`max_revisit`, default 32 slots) sets this search/track balance.
* The bandit gets the highest raw hit rate but the worst coverage: it parks on busy bands. This is why the reward pays for *revisit value* and new emitters, not raw hits.

## Mapping to the problem statement
| Requirement | Where |
|---|---|
| Simulated RF environment with truth per band per time slot | `environment.py`, `emitters.py` |
| System model for the receiver | `receiver.py` |
| Pd, Pfa, sensitivity, intercept rate, reward/cost, % correct predictions, intercept-time error | `metrics.py` |
| Predict intercept time and interception ratio vs spatially scanning and frequency-agile emitters | `theory.py`, `predictor.py` |
| ML scheduler minimising intercept time and maximising interception rate | `rl.py`, `predictor.py`, `schedulers.py` |
| Trained on hits and misses | GRU (supervised on hit/miss sequences), DQN (reward from hits/misses/false alarms) |
| Approaches to intercept a periodic scan optimally | `theory.py` (`optimal_revisit`, `robust_revisit`), acquisition/tracking in `ModelBasedScheduler` |
| Scheduler software | `server/` + `web/` dashboard |
