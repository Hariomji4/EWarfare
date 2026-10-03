# Results (2026-10-03 18:01)

## Unseen random scenarios (n=2)

| Scheduler | Intercept ratio | Threat-wtd IR | Emitters found | Mean intercept time (slots) | Mean info age (slots) | Hit rate | Pd | Pfa | Avg reward | Prediction acc. | Intercept-time error (slots) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Round-robin (open loop) | 0.264 | 0.306 | 0.929 | 182.5 | 119.5 | 0.097 | 0.905 | 0.002 | 0.111 | - | - |
| Random sweep (open loop) | 0.206 | 0.227 | 0.917 | 125.6 | 129.0 | 0.074 | 0.836 | 0.000 | 0.095 | - | - |
| Random dwell | 0.185 | 0.200 | 0.929 | 226.7 | 137.4 | 0.080 | 0.865 | 0.002 | 0.090 | - | - |
| Thompson bandit | 0.195 | 0.210 | 0.917 | 258.0 | 192.3 | 0.161 | 0.938 | 0.001 | 0.086 | 0.839 | - |
| Smart scan: model-based | 0.302 | 0.358 | 0.929 | 271.5 | 154.5 | 0.108 | 0.875 | 0.001 | 0.095 | 0.892 | 37.2 |
| Smart scan: GRU predictor | 0.437 | 0.497 | 1.000 | 104.7 | 121.4 | 0.175 | 0.919 | 0.003 | 0.111 | 0.780 | 11.3 |
| Smart scan: RL (DQN) | 0.380 | 0.411 | 1.000 | 168.0 | 110.5 | 0.181 | 0.923 | 0.002 | 0.117 | 0.801 | 12.5 |

## Preset: air_defence (3 seeds)

| Scheduler | Intercept ratio | Threat-wtd IR | Emitters found | Mean intercept time (slots) | Mean info age (slots) | Hit rate | Avg reward |
|---|---|---|---|---|---|---|---|
| Round-robin (open loop) | 0.208 | 0.197 | 0.917 | 246.3 | 133.4 | 0.144 | 0.132 |
| Random sweep (open loop) | 0.197 | 0.181 | 1.000 | 88.1 | 106.7 | 0.140 | 0.146 |
| Random dwell | 0.194 | 0.186 | 0.917 | 180.3 | 145.5 | 0.144 | 0.135 |
| Thompson bandit | 0.106 | 0.099 | 0.833 | 233.1 | 214.3 | 0.575 | 0.096 |
| Smart scan: model-based | 0.632 | 0.663 | 1.000 | 85.0 | 74.9 | 0.343 | 0.182 |
| Smart scan: GRU predictor | 0.700 | 0.743 | 0.958 | 221.8 | 113.8 | 0.388 | 0.149 |
| Smart scan: RL (DQN) | 0.574 | 0.635 | 0.833 | 249.8 | 145.6 | 0.398 | 0.156 |

## Preset: agile_threat (3 seeds)

| Scheduler | Intercept ratio | Threat-wtd IR | Emitters found | Mean intercept time (slots) | Mean info age (slots) | Hit rate | Avg reward |
|---|---|---|---|---|---|---|---|
| Round-robin (open loop) | 0.110 | 0.100 | 1.000 | 116.1 | 97.0 | 0.072 | 0.110 |
| Random sweep (open loop) | 0.137 | 0.126 | 0.933 | 121.6 | 130.8 | 0.089 | 0.108 |
| Random dwell | 0.147 | 0.139 | 1.000 | 108.9 | 161.0 | 0.101 | 0.110 |
| Thompson bandit | 0.138 | 0.127 | 1.000 | 81.9 | 104.1 | 0.145 | 0.104 |
| Smart scan: model-based | 0.292 | 0.287 | 0.933 | 182.2 | 114.2 | 0.178 | 0.118 |
| Smart scan: GRU predictor | 0.381 | 0.377 | 1.000 | 198.9 | 102.4 | 0.238 | 0.108 |
| Smart scan: RL (DQN) | 0.362 | 0.359 | 0.867 | 264.7 | 166.6 | 0.280 | 0.103 |

## Preset: dense_comms (3 seeds)

| Scheduler | Intercept ratio | Threat-wtd IR | Emitters found | Mean intercept time (slots) | Mean info age (slots) | Hit rate | Avg reward |
|---|---|---|---|---|---|---|---|
| Round-robin (open loop) | 0.628 | 0.582 | 1.000 | 46.3 | 53.1 | 0.365 | 0.191 |
| Random sweep (open loop) | 0.592 | 0.545 | 1.000 | 75.4 | 60.5 | 0.360 | 0.187 |
| Random dwell | 0.508 | 0.484 | 1.000 | 30.9 | 52.8 | 0.355 | 0.185 |
| Thompson bandit | 0.344 | 0.316 | 0.879 | 164.3 | 114.2 | 0.751 | 0.130 |
| Smart scan: model-based | 0.647 | 0.616 | 0.970 | 80.5 | 55.9 | 0.351 | 0.194 |
| Smart scan: GRU predictor | 0.693 | 0.638 | 0.939 | 106.0 | 81.4 | 0.399 | 0.188 |
| Smart scan: RL (DQN) | 0.678 | 0.625 | 0.970 | 93.9 | 65.7 | 0.425 | 0.188 |

## Preset: popup_threats (3 seeds)

| Scheduler | Intercept ratio | Threat-wtd IR | Emitters found | Mean intercept time (slots) | Mean info age (slots) | Hit rate | Avg reward |
|---|---|---|---|---|---|---|---|
| Round-robin (open loop) | 0.160 | 0.143 | 1.000 | 55.8 | 63.3 | 0.082 | 0.090 |
| Random sweep (open loop) | 0.165 | 0.147 | 0.933 | 83.6 | 106.0 | 0.086 | 0.083 |
| Random dwell | 0.149 | 0.136 | 1.000 | 98.0 | 88.3 | 0.082 | 0.085 |
| Thompson bandit | 0.089 | 0.077 | 0.933 | 117.0 | 138.4 | 0.362 | 0.064 |
| Smart scan: model-based | 0.301 | 0.286 | 1.000 | 119.4 | 59.4 | 0.131 | 0.100 |
| Smart scan: GRU predictor | 0.276 | 0.255 | 1.000 | 88.1 | 75.7 | 0.133 | 0.101 |
| Smart scan: RL (DQN) | 0.323 | 0.303 | 1.000 | 135.3 | 52.3 | 0.197 | 0.103 |

## Intercept prediction model vs simulation

| Case | Model | Pred. time | Sim. time | Pred. IR | Sim. IR | Pred. lock-out | Sim. lock-out |
|---|---|---|---|---|---|---|---|
| Scanning T_s=37 tau_s=3 | phase-lattice (exact) | 118.5 | 110.2 | 0.188 | 0.187 | 0.00 | 0.00 |
| Scanning T_s=53 tau_s=2 | phase-lattice (exact) | 268.5 | 265.2 | 0.125 | 0.125 | 0.00 | 0.00 |
| Scanning T_s=61 tau_s=4 | phase-lattice (exact) | 115.5 | 113.7 | 0.250 | 0.249 | 0.00 | 0.00 |
| Scanning T_s=97 tau_s=4 | phase-lattice (exact) | 475.5 | 514.1 | 0.250 | 0.250 | 0.00 | 0.00 |
| Scanning T_s=64 tau_s=3 | phase-lattice (exact) | 1.0 | 2.9 | 0.188 | 0.213 | 0.81 | 0.79 |
| Scanning T_s=80 tau_s=5 | phase-lattice (exact) | 2.0 | 4.6 | 0.312 | 0.346 | 0.69 | 0.65 |
| Agile K=4 hop=2 | random-hop analytic | 16.0 | 11.6 | 0.167 | 0.166 | 0.00 | 0.00 |
| Agile K=6 hop=3 | random-hop analytic | 16.0 | 12.8 | 0.225 | 0.226 | 0.00 | 0.00 |
| Agile K=8 hop=1 | random-hop analytic | 16.0 | 14.7 | 0.071 | 0.072 | 0.00 | 0.00 |

Mean absolute intercept-time error: 8.7 slots (12.8 %); mean absolute IR error 0.007.