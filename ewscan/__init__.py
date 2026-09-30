"""ewscan - Smart Scan Strategy for Electronic Support (ES) receivers.

Modules
-------
receiver      Receiver system model (noise floor, Pd/Pfa, sensitivity).
emitters      Emitter behaviour models (scanning, frequency-agile, comms, ...).
scenario      Scenario definitions, presets and randomised scenario generator.
environment   Simulated RF environment holding ground truth per band per slot.
tracker       Online observation tracker + periodicity / phase estimation.
schedulers    Open-loop baselines, bandit, model-based and learned schedulers.
predictor     GRU activity predictor (supervised, trained on hits/misses).
rl            Deep Q-Network scheduler (reinforcement learning).
theory        Analytical intercept-time / interception-ratio model and
              optimal periodic-scan (revisit period) design.
metrics       Figures of merit for interception performance.
"""

__version__ = "1.0.0"
