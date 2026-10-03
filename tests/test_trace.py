"""Tests for Live Intercept Theatre trace builder (ewscan/trace.py and POST /api/trace).

Run with:
    python tests/test_trace.py
or
    pytest tests/test_trace.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import asyncio
import httpx

from ewscan.trace import build_trace, get_scheduler
from server.app import app


def api_post(path: str, json_data: dict) -> httpx.Response:
    async def _call():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
            return await ac.post(path, json=json_data)
    return asyncio.run(_call())


VALID_STATUSES = {"INTERCEPTED", "PARTIAL", "MISSED_NOT_LISTENING", "MISSED_NOT_DETECTED"}


def test_core_properties_for_schedulers_and_seeds():
    """Verify trace requirements 1-4 for at least 2 schedulers and 2 seeds."""
    schedulers = ["round_robin", "model_based"]
    seeds = [1, 42]
    scenario = "air_defence"

    for sched in schedulers:
        for seed in seeds:
            trace = build_trace(sched, scenario, seed=seed)

            meta = trace["meta"]
            messages = trace["messages"]
            outcomes = trace["outcomes"]
            dwell = trace["dwell"]
            detect = trace["detect"]
            summary = trace["summary"]
            n_slots = meta["n_slots"]

            # Requirement 1: Every message has exactly one outcome with a valid status
            assert len(messages) == len(outcomes), f"Mismatch in count for {sched} seed {seed}"
            for i, (msg, outcome) in enumerate(zip(messages, outcomes)):
                assert msg["id"] == outcome["message_id"], f"ID mismatch at index {i}"
                assert outcome["status"] in VALID_STATUSES, f"Invalid status: {outcome['status']}"

            # Requirement 2: Status counts sum to the number of messages
            status_counts = summary["status_counts"]
            total_counted = sum(status_counts.values())
            assert total_counted == len(messages), (
                f"Status counts sum {total_counted} != message count {len(messages)}"
            )

            # Requirement 3: Dwell relationship for INTERCEPTED/PARTIAL vs MISSED_NOT_LISTENING
            for msg, outcome in zip(messages, outcomes):
                band = msg["band"]
                s = msg["start_slot"]
                e = msg["end_slot"]
                status = outcome["status"]

                listened_during = [dwell[t] == band for t in range(s, e + 1)]
                has_dwelled = any(listened_during)

                if status in ("INTERCEPTED", "PARTIAL"):
                    assert has_dwelled, (
                        f"Message {msg['id']} marked {status} but receiver never dwelled on band {band} in [{s}, {e}]"
                    )
                    assert outcome["n_hit_slots"] > 0
                    assert outcome["first_hit_slot"] is not None
                elif status == "MISSED_NOT_LISTENING":
                    assert not has_dwelled, (
                        f"Message {msg['id']} marked MISSED_NOT_LISTENING but receiver dwelled on band {band} in [{s}, {e}]"
                    )
                    assert outcome["n_listen_slots"] == 0
                    assert outcome["n_hit_slots"] == 0
                elif status == "MISSED_NOT_DETECTED":
                    assert has_dwelled, (
                        f"Message {msg['id']} marked MISSED_NOT_DETECTED but receiver never dwelled on band {band}"
                    )
                    assert outcome["n_hit_slots"] == 0
                    assert outcome["first_hit_slot"] is None

            # Requirement 4: len(dwell) == len(detect) == n_slots; all dwell values valid
            assert len(dwell) == n_slots, f"dwell len {len(dwell)} != n_slots {n_slots}"
            assert len(detect) == n_slots, f"detect len {len(detect)} != n_slots {n_slots}"
            assert all(0 <= b < 16 for b in dwell), f"Invalid band index found in dwell"
            assert all(isinstance(d, bool) for d in detect), f"detect elements must be bool"


def test_determinism():
    """Requirement 5: The same inputs give an identical trace (including payload text)."""
    t1 = build_trace("model_based", "air_defence", seed=7)
    t2 = build_trace("model_based", "air_defence", seed=7)

    # Exclude generated timestamp
    t1_meta = dict(t1["meta"])
    t2_meta = dict(t2["meta"])
    t1_meta.pop("generated", None)
    t2_meta.pop("generated", None)
    assert t1_meta == t2_meta

    assert t1["dwell"] == t2["dwell"]
    assert t1["detect"] == t2["detect"]
    assert t1["messages"] == t2["messages"]
    assert t1["outcomes"] == t2["outcomes"]
    assert t1["paragraphs"] == t2["paragraphs"]
    assert t1["summary"]["status_counts"] == t2["summary"]["status_counts"]


def test_same_seed_different_scheduler_identical_messages():
    """Requirement 6: Same seed + different scheduler gives identical messages list."""
    t_rr = build_trace("round_robin", "air_defence", seed=10)
    t_mb = build_trace("model_based", "air_defence", seed=10)

    # Ground-truth messages must be identical
    assert len(t_rr["messages"]) == len(t_mb["messages"])
    for m_rr, m_mb in zip(t_rr["messages"], t_mb["messages"]):
        assert m_rr == m_mb, f"Message mismatch: {m_rr} vs {m_mb}"

    # Dwell sequence must differ because schedulers differ
    assert t_rr["dwell"] != t_mb["dwell"]

    # Model-based must expose phase and phase_legend; round_robin must omit them
    assert "phase" in t_mb
    assert "phase_legend" in t_mb
    assert len(t_mb["phase"]) == t_mb["meta"]["n_slots"]
    assert "phase" not in t_rr


def test_consistency_with_compute_metrics():
    """Requirement 7: Check consistency between trace-derived IR and compute_metrics."""
    trace = build_trace("model_based", "air_defence", seed=15)
    summary = trace["summary"]
    consistency = summary["consistency"]

    # In compute_metrics, an event is caught if >= 1 slot was detected during the burst.
    # In trace, that corresponds exactly to status in ("INTERCEPTED", "PARTIAL").
    assert "trace_ir_any" in consistency
    assert "compute_metrics_ir" in consistency
    assert "diff_vs_metrics" in consistency

    # The difference between trace_ir_any and compute_metrics_ir should be 0.0 on full runs
    assert consistency["diff_vs_metrics"] == 0.0, (
        f"Unexpected difference: {consistency['diff_vs_metrics']} (trace={consistency['trace_ir_any']}, metrics={consistency['compute_metrics_ir']})"
    )


def test_untrained_model_error_handling():
    """Requirement 8: Requesting an untrained model returns a clean error, not a 500."""
    # Test via direct function call with a non-existent models directory
    dummy_dir = ROOT / "non_existent_models_dir_xyz"
    try:
        get_scheduler("gru_predictor", models_dir=dummy_dir)
        assert False, "Should have raised RuntimeError"
    except RuntimeError as e:
        assert "not trained" in str(e).lower()

    # Test via FastAPI endpoint with an unknown scheduler
    res = api_post("/api/trace", json_data={"scheduler": "unknown_scheduler_xyz", "scenario": "air_defence", "seed": 1})
    assert res.status_code == 400
    assert "unknown scheduler" in res.json()["detail"].lower()

    # Test invalid n_slots
    res_slots = api_post("/api/trace", json_data={"scheduler": "round_robin", "scenario": "air_defence", "n_slots": 99999})
    assert res_slots.status_code == 400
    assert "n_slots" in res_slots.json()["detail"].lower()

    # Test invalid preset
    res_preset = api_post("/api/trace", json_data={"scheduler": "round_robin", "scenario": "non_existent_preset_xyz"})
    assert res_preset.status_code == 400
    assert "unknown" in res_preset.json()["detail"].lower()


def test_api_endpoint_trace():
    """Acceptance: Verify POST /api/trace returns 200 with complete schema."""
    res = api_post("/api/trace", json_data={"scheduler": "round_robin", "scenario": "air_defence", "seed": 1})
    assert res.status_code == 200
    data = res.json()

    # Check top-level keys
    expected_keys = {"meta", "bands", "emitters", "dwell", "detect", "messages", "outcomes", "false_alarms", "summary", "paragraphs"}
    assert expected_keys.issubset(data.keys())

    assert data["meta"]["n_slots"] == 1000
    assert data["meta"]["scheduler"] == "round_robin"
    assert len(data["dwell"]) == 1000
    assert len(data["detect"]) == 1000
    assert len(data["bands"]) == 16
    assert len(data["messages"]) > 0

    # Model-based call
    res_mb = api_post("/api/trace", json_data={"scheduler": "model_based", "scenario": "air_defence", "seed": 1})
    assert res_mb.status_code == 200
    data_mb = res_mb.json()
    assert "phase" in data_mb
    assert "phase_legend" in data_mb
    assert len(data_mb["phase"]) == 1000
    assert data_mb["messages"] == data["messages"]
    assert data_mb["dwell"] != data["dwell"]


if __name__ == "__main__":
    print("Running tests in tests/test_trace.py...")
    test_core_properties_for_schedulers_and_seeds()
    print("  [PASS] test_core_properties_for_schedulers_and_seeds")
    test_determinism()
    print("  [PASS] test_determinism")
    test_same_seed_different_scheduler_identical_messages()
    print("  [PASS] test_same_seed_different_scheduler_identical_messages")
    test_consistency_with_compute_metrics()
    print("  [PASS] test_consistency_with_compute_metrics")
    test_untrained_model_error_handling()
    print("  [PASS] test_untrained_model_error_handling")
    test_api_endpoint_trace()
    print("  [PASS] test_api_endpoint_trace")
    print("\nALL 6 TEST SUITES PASSED PERFECTLY!")
