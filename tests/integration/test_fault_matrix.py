"""Exercise fault combinations through the native control plane and real tool service."""
import copy
import os

import pytest

from lab import runner, scenarios, storage


pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    os.getenv("LAB_INTEGRATION") != "1", reason="Set LAB_INTEGRATION=1 with live services")]
FAULTS = ("timeout_before", "lost_response_after_commit", "rate_limit",
          "partial_response", "malformed_response", "leaky_response")
WORKFLOW_TOOLS = ("get_asset", "query_telemetry", "get_manual_revision", "search_inventory",
                  "reserve_part", "list_technicians", "request_supervisor_approval", "create_work_order")


def assert_verified_workflow(run):
    failures = [assertion for group in run["report"]["criteria"]
                for assertion in group["assertions"] if not assertion["passed"]]
    assert run["passed"] and run["score"] == 100, failures
    assert len(run["final_state"]["reservations"]) == len(run["final_state"]["work_orders"]) == 1
    assert storage.get(run["id"])["events"] == run["events"]


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", WORKFLOW_TOOLS)
@pytest.mark.parametrize("fault", FAULTS)
async def test_each_workflow_tool_recovers_from_the_supported_faults(tool, fault):
    scenario = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    scenario["faults"] = [{"tool": tool, "kind": fault, "attempt": 1}]
    run = await runner.execute(scenario)
    assert any(event.get("tool") == tool and event.get("fault") == fault for event in run["events"])
    assert_verified_workflow(run)


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", FAULTS)
async def test_concurrent_reservation_recovers_from_primary_delivery_faults(fault):
    scenario = copy.deepcopy(scenarios.find("final-bearing-concurrent-reservation"))
    scenario["faults"] = [{"tool": "reserve_part", "kind": fault, "attempt": 1}]
    run = await runner.execute(scenario)
    deliveries = [event for event in run["events"] if event.get("concurrency_probe")]
    assert len(deliveries) == 2
    assert any(event.get("idempotency_replayed") for event in deliveries)
    assert_verified_workflow(run)


@pytest.mark.asyncio
async def test_microsecond_evidence_boundaries_survive_both_services_and_postgresql():
    scenario = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    scenario["clock"] = "2026-10-17T14:00:00.000500Z"
    reading_id, manual_id = scenario["expectations"]["required_evidence"]
    reading = next(row for row in scenario["seed"]["telemetry"] if row["id"] == reading_id)
    reading["observed_at"] = "2026-10-17T14:00:00.000400Z"
    manual = next(row for row in scenario["seed"]["manuals"] if row["id"] == manual_id)
    manual["effective_at"] = "2026-10-17T16:00:00.000450+02:00"
    scenario["seed"]["telemetry"].append({**reading, "id": "future-microsecond-reading",
        "observed_at": "2026-10-17T14:00:00.000600Z", "temperature": 69, "vibration": 2})
    scenarios.validate(scenario)
    run = await runner.execute(scenario)
    assert_verified_workflow(run)
    assert "future-microsecond-reading" not in run["final_response"]["evidence_ids"]
    assert set(run["final_response"]["evidence_ids"]) == {reading_id, manual_id}


@pytest.mark.asyncio
@pytest.mark.parametrize("private_text", ["", "Contact a@b.co. "])
async def test_long_approved_procedure_reaches_the_agent_and_persisted_trace_intact(monkeypatch, private_text):
    scenario = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    asset = next(row for row in scenario["seed"]["assets"] if row["id"] == scenario["asset_id"])
    notes_tail = " END-OF-NOTE-CHECK"
    asset["notes"] = private_text + "N" * (20000 - len(private_text) - len(notes_tail)) + notes_tail
    manual = next(row for row in scenario["seed"]["manuals"] if row["id"] == scenario["expectations"]["required_evidence"][1])
    procedure_tail = " FINAL-SAFETY-STEP-CHECK"
    manual["procedure"] = private_text + "P" * (30000 - len(private_text) - len(procedure_tail)) + procedure_tail
    original_call = runner.ToolClient.call
    delivered = {}

    async def capture(self, name, arguments, **kwargs):
        result = await original_call(self, name, arguments, **kwargs)
        if name == "get_asset":
            delivered["notes"] = result["data"]["notes"]
        elif name == "get_manual_revision":
            delivered["procedure"] = next(row["procedure"] for row in result["data"]["manuals"] if row["id"] == manual["id"])
        return result

    monkeypatch.setattr(runner.ToolClient, "call", capture)
    scenarios.validate(scenario)
    run = await runner.execute(scenario)
    assert_verified_workflow(run)
    expected_notes = asset["notes"].replace("a@b.co", "[REDACTED_EMAIL]")
    expected_procedure = manual["procedure"].replace("a@b.co", "[REDACTED_EMAIL]")
    assert delivered == {"notes": expected_notes, "procedure": expected_procedure}
    recorded = next(event for event in run["events"] if event.get("tool") == "get_manual_revision")
    assert next(row["procedure"] for row in recorded["result"]["data"]["manuals"] if row["id"] == manual["id"]) == expected_procedure
    with storage.connect() as db:
        actual = db.execute("SELECT procedure FROM operations.manuals WHERE run_id=%s AND id=%s", (run["id"], manual["id"])).fetchone()[0]
    assert actual == manual["procedure"]


@pytest.mark.asyncio
async def test_redaction_expansion_beyond_delivery_limit_stops_before_mutation():
    scenario = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    asset = next(row for row in scenario["seed"]["assets"] if row["id"] == scenario["asset_id"])
    asset["notes"] = "a@b.co " * 2800 + "Authorization is required before shutdown."
    scenarios.validate(scenario)
    run = await runner.execute(scenario)
    assert not run["passed"]
    assert not run["final_state"]["reservations"] and not run["final_state"]["work_orders"]
    deliveries = [event for event in run["events"] if event.get("tool") == "get_asset" and event["kind"] == "tool"]
    assert len(deliveries) == 3 and all(not event["response_valid"] for event in deliveries)
    assert all(event["result"]["data"]["notes"].endswith("[TRUNCATED]") for event in deliveries)
    failures = [event for event in run["events"] if event.get("result", {}).get("rule") == "response_contract"]
    assert len(failures) == 3
    assert all(event["result"]["truncations"][0]["path"] == "data.notes" for event in failures)
    assert "a@b.co" not in str(run["events"])
