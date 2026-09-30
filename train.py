"""Train the learned schedulers.

    python train.py predictor     # supervised GRU activity predictor
    python train.py rl            # DQN scheduler (uses the predictor if present)
    python train.py all
"""
import argparse
import json
from pathlib import Path

import torch

ROOT = Path(__file__).parent
MODELS = ROOT / "models"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["predictor", "rl", "all"])
    ap.add_argument("--episodes", type=int, default=400, help="predictor training episodes")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--steps", type=int, default=300_000, help="RL environment steps")
    ap.add_argument("--threads", type=int, default=8)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    MODELS.mkdir(exist_ok=True)
    log_file = open(MODELS / f"train_{args.what}.log", "a", buffering=1)

    def log(msg):
        print(msg, flush=True)
        log_file.write(msg + "\n")

    if args.what in ("predictor", "all"):
        from ewscan.predictor import train_predictor
        res = train_predictor(MODELS / "predictor.pt", n_train=args.episodes, epochs=args.epochs, log=log)
        log(json.dumps(res))
    if args.what in ("rl", "all"):
        from ewscan.rl import train_dqn
        res = train_dqn(MODELS / "dqn.pt", total_steps=args.steps, predictor_path=MODELS / "predictor.pt",
                        log=log)
        log(json.dumps(res))


if __name__ == "__main__":
    main()
