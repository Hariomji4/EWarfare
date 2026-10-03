"""Live Intercept Theatre: trace builder.

Constructs comprehensive, compact execution traces of Electronic Support (ES)
receiver dwell schedules against ground-truth RF emitter transmission bursts.
Produces message-level outcomes (INTERCEPTED, PARTIAL, MISSED_NOT_LISTENING,
MISSED_NOT_DETECTED), false alarms, per-band/per-type summaries, and paragraph
reconstruction IDs.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from .environment import RFEnvironment
from .metrics import _runs, compute_metrics
from .receiver import ReceiverConfig
from .scenario import PRESETS, Scenario, preset, random_scenario
from .schedulers import (ModelBasedScheduler, RandomScheduler, RandomSweepScheduler,
                         RoundRobinScheduler, Scheduler, ThompsonScheduler, run_episode)

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "models"


def get_color_key(emitter_name: str, emitter_kind: str, emitter_index: int) -> str:
    """Map an emitter to a consistent palette color key.

    Supported keys:
        search_a, search_b, search_c  (scanning radars)
        fire_ctl                      (tracking/fire-control radars)
        nav_beacon                    (navigation beacons)
        agile_acq                     (frequency-agile radars)
        voice, datalink               (communications nets)

    Mapping priority:
    1. Canonical names from preset scenarios (e.g. 'Search-A' -> 'search_a', 'Voice' -> 'voice').
    2. Heuristic keywords in the emitter name.
    3. Structural fallback by emitter kind with index cycling.
    """
    nl = emitter_name.lower().replace("_", "-")
    if "search-a" in nl or "sr-1" in nl:
        return "search_a"
    if "search-b" in nl or "sr-2" in nl:
        return "search_b"
    if "search-c" in nl or "sr-3" in nl:
        return "search_c"
    if "firectl" in nl or "fc" in nl or "track" in nl or "tr-" in nl:
        return "fire_ctl"
    if "beacon" in nl or "nav" in nl or "bc-" in nl:
        return "nav_beacon"
    if "agile" in nl or "ag-" in nl:
        return "agile_acq"
    if "voice" in nl:
        return "voice"
    if "datalink" in nl or "cm-" in nl or "comms" in nl:
        return "datalink"

    if emitter_kind == "scanning_radar":
        keys = ["search_a", "search_b", "search_c"]
        return keys[emitter_index % len(keys)]
    elif emitter_kind == "tracking_radar":
        return "fire_ctl"
    elif emitter_kind == "agile_radar":
        return "agile_acq"
    elif emitter_kind == "beacon":
        return "nav_beacon"
    elif emitter_kind == "comms":
        keys = ["datalink", "voice"]
        return keys[emitter_index % len(keys)]
    return "search_a"


def generate_payload(msg_id: int, emitter_name: str, band: int, start_slot: int) -> str:
    """Generate a deterministic synthetic message payload token.

    Seeded deterministically by msg_id, emitter_name, band, and start_slot.
    Example: 'NAVBEACON#03 B07 t=412'.
    """
    tag = emitter_name.upper().replace(" ", "-")
    return f"{tag}#{msg_id:02d} B{band:02d} t={start_slot}"


def get_scheduler(name: str, models_dir: Path | str | None = None) -> Scheduler:
    """Instantiate a scheduler by name, loading weights if required."""
    models_path = Path(models_dir) if models_dir else MODELS_DIR
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
        from .predictor import PredictorScheduler, load_predictor
        p_path = models_path / "predictor.pt"
        if not p_path.exists():
            raise RuntimeError("model not trained: gru_predictor (python train.py predictor)")
        pred = load_predictor(p_path)
        if pred is None:
            raise RuntimeError("model not trained: gru_predictor (failed to load weights)")
        return PredictorScheduler(pred)
    if name == "dqn":
        from .rl import load_dqn
        q_path = models_path / "dqn.pt"
        if not q_path.exists():
            raise RuntimeError("model not trained: dqn (python train.py rl)")
        s = load_dqn(q_path, models_path / "predictor.pt")
        if s is None:
            raise RuntimeError("model not trained: dqn (failed to load weights)")
        return s
    raise ValueError(f"Unknown scheduler '{name}'")


def _to_plain_python(obj: Any) -> Any:
    """Recursively convert numpy types and non-standard collections to standard Python types."""
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        val = float(obj)
        return None if not np.isfinite(val) else val
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return [_to_plain_python(x) for x in obj.tolist()]
    if isinstance(obj, dict):
        return {str(k): _to_plain_python(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_plain_python(x) for x in obj]
    return obj


def build_trace(scheduler_name: str | Scheduler,
                scenario: str | dict,
                seed: int = 0,
                n_slots: int | None = None,
                models_dir: Path | str | None = None) -> dict:
    """Build a detailed execution trace for the Live Intercept Theatre.

    Parameters
    ----------
    scheduler_name : str | Scheduler
        Name of the scheduler (or an instantiated Scheduler object).
    scenario : str | dict
        Preset name (e.g. 'air_defence') or scenario dictionary.
    seed : int
        Simulation random seed (used for ground-truth noise and scheduler tie-breaking).
    n_slots : int | None
        Number of time slots to simulate (defaults to scenario.T, capped at 5000).
    models_dir : Path | str | None
        Optional directory containing trained model checkpoints.

    Returns
    -------
    dict
        JSON-serializable execution trace conforming to the Live Intercept Theatre schema.
    """
    # 1. Resolve Scenario
    if isinstance(scenario, dict):
        sc = Scenario.from_dict(scenario)
        if n_slots is not None:
            sc.T = int(n_slots)
    elif isinstance(scenario, str):
        if scenario in PRESETS:
            sc = preset(scenario, T=int(n_slots)) if n_slots is not None else preset(scenario)
        elif scenario.startswith("random"):
            sc = random_scenario(np.random.default_rng(seed), T=int(n_slots) if n_slots is not None else 1000)
        else:
            raise ValueError(f"Unknown scenario preset '{scenario}'")
    else:
        raise TypeError(f"Scenario must be a preset name (str) or dict, got {type(scenario).__name__}")

    if sc.T > 5000 or sc.n_bands > 64:
        raise ValueError("Scenario too large (maximum 5000 slots and 64 bands)")

    T = sc.T
    N = sc.n_bands

    # 2. Resolve Scheduler
    if isinstance(scheduler_name, Scheduler):
        sched = scheduler_name
        sched_name = sched.name
    elif isinstance(scheduler_name, str):
        sched_name = scheduler_name
        sched = get_scheduler(scheduler_name, models_dir=models_dir)
    else:
        raise TypeError(f"scheduler_name must be str or Scheduler, got {type(scheduler_name).__name__}")

    # 3. Build RF Environment and Run Episode
    env = RFEnvironment(sc, seed=seed)
    log = run_episode(env, sched, seed=seed, record=True)
    metrics = compute_metrics(env, log)

    # 4. Extract Bands Metadata
    rx = env.rx
    edges = rx.band_edges_ghz
    bands = []
    for b in range(N):
        f_lo = float(edges[b])
        f_hi = float(edges[b + 1])
        bands.append({
            "index": int(b),
            "f_lo_ghz": round(f_lo, 3),
            "f_hi_ghz": round(f_hi, 3),
            "label": f"B{b:02d} · {f_lo:g}-{f_hi:g} GHz",
        })

    # 5. Extract Emitters Metadata
    emitters = []
    for e_idx, em in enumerate(sc.emitters):
        b_active = env.em_band[e_idx]
        valid_bands = sorted(list(set(int(b) for b in b_active if b >= 0)))
        c_key = get_color_key(em.name, em.kind, e_idx)
        emitters.append({
            "id": int(e_idx),
            "name": em.name,
            "type": em.kind,
            "color_key": c_key,
            "threat": float(em.threat),
            "bands": valid_bands,
        })

    # 6. Extract Dwell and Detection Streams
    dwell = [int(a) for a in log["actions"]]
    detect = [bool(d) for d in log["detections"]]

    # 7. Extract Transmission Messages (Ground-Truth Bursts)
    # A message is a contiguous run of slots where an emitter transmits on a band.
    # If a frequency-agile radar hops across bands, each band run is a distinct message.
    raw_messages = []
    for e_idx, em in enumerate(sc.emitters):
        b_arr = env.em_band[e_idx]
        live = b_arr >= 0
        if not live.any():
            continue
        runs = _runs(live, b_arr)
        c_key = get_color_key(em.name, em.kind, e_idx)
        threat_val = float(em.threat)
        for s, t_end in runs:
            # s is inclusive, t_end is exclusive (Python slice notation)
            # end_slot is defined as the last inclusive slot: t_end - 1
            band = int(b_arr[s])
            pwr = float(env.em_power[e_idx, s])
            if not np.isfinite(pwr):
                pwr = float(env.rx.noise_floor_dbm)
            raw_messages.append({
                "emitter_id": int(e_idx),
                "name": em.name,
                "type": em.kind,
                "color_key": c_key,
                "band": band,
                "start_slot": int(s),
                "end_slot": int(t_end - 1),
                "power_dbm": round(pwr, 1),
                "threat": threat_val,
            })

    # Sort messages stably by (start_slot, band, emitter_id)
    raw_messages.sort(key=lambda m: (m["start_slot"], m["band"], m["emitter_id"]))

    messages = []
    outcomes = []
    transmitted_ids = []
    received_ids = []

    for msg_id, rm in enumerate(raw_messages):
        s = rm["start_slot"]
        e = rm["end_slot"]
        band = rm["band"]
        burst_len = e - s + 1

        payload = generate_payload(msg_id, rm["name"], band, s)

        messages.append({
            "id": int(msg_id),
            "emitter_id": rm["emitter_id"],
            "emitter_name": rm["name"],
            "type": rm["type"],
            "color_key": rm["color_key"],
            "band": band,
            "start_slot": s,
            "end_slot": e,
            "power_dbm": rm["power_dbm"],
            "threat": rm["threat"],
            "payload": payload,
        })
        transmitted_ids.append(int(msg_id))

        # Evaluate outcome during burst window [s, e]
        listened_slots = [t for t in range(s, e + 1) if dwell[t] == band]
        hit_slots = [t for t in listened_slots if detect[t]]
        listened_bands = sorted(list(set(dwell[s: e + 1])))

        n_listen = len(listened_slots)
        n_hits = len(hit_slots)
        first_hit = int(hit_slots[0]) if n_hits > 0 else None

        # Precise Outcome Status Definition:
        # - MISSED_NOT_LISTENING: receiver never tuned to the burst band during [s, e]
        # - MISSED_NOT_DETECTED: receiver listened in >=1 slot, but detector never fired
        # - INTERCEPTED: detector fired in all slots if burst_len >= 2 and listened, or burst_len == 1 and fired
        # - PARTIAL: burst of 2+ slots where some but not all slots fired or listening covered only part of burst
        if n_listen == 0:
            status = "MISSED_NOT_LISTENING"
        elif n_hits == 0:
            status = "MISSED_NOT_DETECTED"
        else:
            if burst_len == 1 or n_hits == burst_len:
                status = "INTERCEPTED"
            else:
                status = "PARTIAL"

        outcomes.append({
            "message_id": int(msg_id),
            "status": status,
            "first_hit_slot": first_hit,
            "n_hit_slots": int(n_hits),
            "n_listen_slots": int(n_listen),
            "listened_bands_during": listened_bands,
        })

        if status in ("INTERCEPTED", "PARTIAL"):
            received_ids.append(int(msg_id))

    # 8. Extract False Alarms
    false_alarms = []
    active_grid = env.active
    for t in range(T):
        b = dwell[t]
        if detect[t] and not active_grid[b, t]:
            false_alarms.append({"slot": int(t), "band": int(b)})

    # 9. Build Summary Statistics
    status_counts = {
        "INTERCEPTED": sum(1 for o in outcomes if o["status"] == "INTERCEPTED"),
        "PARTIAL": sum(1 for o in outcomes if o["status"] == "PARTIAL"),
        "MISSED_NOT_LISTENING": sum(1 for o in outcomes if o["status"] == "MISSED_NOT_LISTENING"),
        "MISSED_NOT_DETECTED": sum(1 for o in outcomes if o["status"] == "MISSED_NOT_DETECTED"),
    }
    total_msgs = len(messages)
    status_percentages = {
        k: round(v / max(total_msgs, 1) * 100, 2) for k, v in status_counts.items()
    }

    per_band = {}
    for b in range(N):
        b_msg_ids = [m["id"] for m in messages if m["band"] == b]
        b_outcomes = [outcomes[mid] for mid in b_msg_ids]
        per_band[b] = {
            "sent": len(b_msg_ids),
            "intercepted": sum(1 for o in b_outcomes if o["status"] == "INTERCEPTED"),
            "partial": sum(1 for o in b_outcomes if o["status"] == "PARTIAL"),
            "missed_not_listening": sum(1 for o in b_outcomes if o["status"] == "MISSED_NOT_LISTENING"),
            "missed_not_detected": sum(1 for o in b_outcomes if o["status"] == "MISSED_NOT_DETECTED"),
        }

    distinct_types = sorted(list(set(m["type"] for m in messages)))
    per_emitter_type = {}
    for k in distinct_types:
        k_msg_ids = [m["id"] for m in messages if m["type"] == k]
        k_outcomes = [outcomes[mid] for mid in k_msg_ids]
        per_emitter_type[k] = {
            "sent": len(k_msg_ids),
            "intercepted": sum(1 for o in k_outcomes if o["status"] == "INTERCEPTED"),
            "partial": sum(1 for o in k_outcomes if o["status"] == "PARTIAL"),
            "missed_not_listening": sum(1 for o in k_outcomes if o["status"] == "MISSED_NOT_LISTENING"),
            "missed_not_detected": sum(1 for o in k_outcomes if o["status"] == "MISSED_NOT_DETECTED"),
        }

    # Interception consistency comparison
    trace_caught_count = status_counts["INTERCEPTED"] + status_counts["PARTIAL"]
    trace_ir_any = round(trace_caught_count / max(total_msgs, 1), 5)
    trace_ir_strict = round(status_counts["INTERCEPTED"] / max(total_msgs, 1), 5)
    metrics_ir = round(float(metrics.get("intercept_ratio", 0.0)), 5)
    diff = round(abs(trace_ir_any - metrics_ir), 5)

    consistency = {
        "trace_ir_any": trace_ir_any,
        "trace_ir_strict": trace_ir_strict,
        "compute_metrics_ir": metrics_ir,
        "diff_vs_metrics": diff,
        "definition_note": (
            "compute_metrics considers a transmission burst caught if at least one slot is intercepted "
            "(corresponding exactly to trace INTERCEPTED + PARTIAL). trace_ir_strict requires 100% of "
            "slots in multi-slot bursts to be intercepted."
        ),
    }

    # 10. Construct Final Trace Schema
    meta = {
        "scheduler": sched_name,
        "scenario": sc.name,
        "seed": int(seed),
        "n_slots": int(T),
        "slot_duration_s": float(rx.cfg.dwell_ms / 1000.0),
        "slot_duration_ms": float(rx.cfg.dwell_ms),
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    trace: dict[str, Any] = {
        "meta": meta,
        "bands": bands,
        "emitters": emitters,
        "dwell": dwell,
        "detect": detect,
        "messages": messages,
        "outcomes": outcomes,
        "false_alarms": false_alarms,
        "summary": {
            "status_counts": status_counts,
            "status_percentages": status_percentages,
            "per_band": per_band,
            "per_emitter_type": per_emitter_type,
            "metrics": metrics,
            "consistency": consistency,
        },
        "paragraphs": {
            "transmitted": transmitted_ids,
            "received": received_ids,
        },
    }

    # Include scheduler phase if mode sequence is available
    modes = log.get("modes")
    if modes is not None and len(modes) == T:
        trace["phase"] = modes
        trace["phase_legend"] = {
            "coverage": "Coverage sweep (searching for emitters)",
            "acquisition": "Period acquisition (measuring scan period)",
            "tracking": "Timed interrupt (catching predicted beam)",
        }

    return _to_plain_python(trace)
