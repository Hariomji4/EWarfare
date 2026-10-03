"""Generate offline fallback pre-computed demo trace.

Runs build_trace on 'air_defence' preset with seed 1 for both
Round-robin and the best available smart scan scheduler (model_based / dqn),
and saves the dual trace bundle to web/demo_traces/demo_compare.json.
"""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ewscan.trace import build_trace
OUT_DIR = ROOT / "web" / "demo_traces"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_FILE = OUT_DIR / "demo_compare.json"


def main():
    preset = "air_defence"
    seed = 1
    print(f"Generating demo traces for {preset} (seed={seed})...")

    trace_a = build_trace("round_robin", scenario=preset, seed=seed)

    # Pick best available scheduler: dqn if available, else model_based
    best_name = "model_based"
    models_dir = ROOT / "models"
    if (models_dir / "dqn.pt").exists() and (models_dir / "predictor.pt").exists():
        try:
            trace_b = build_trace("dqn", scenario=preset, seed=seed)
            best_name = "dqn"
        except Exception:
            trace_b = build_trace("model_based", scenario=preset, seed=seed)
    else:
        trace_b = build_trace("model_based", scenario=preset, seed=seed)

    bundle = {
        "scenario": preset,
        "seed": seed,
        "schedulerA": "round_robin",
        "schedulerB": best_name,
        "traceA": trace_a,
        "traceB": trace_b,
    }

    OUT_FILE.write_text(json.dumps(bundle, separators=(",", ":")))
    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"Saved {OUT_FILE} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
