"""Malformed state observations must leave a durable, reviewable failed run."""
import copy
import json
from uuid import uuid4

import httpx
import pytest

from lab import runner, scenarios, storage, tools
from lab.domain import SNAPSHOT_ENTITIES, complete_snapshot


def state():
    value = copy.deepcopy(scenarios.find("conflicting-observation-times")["seed"])
    return {entity: value.get(entity, []) for entity in SNAPSHOT_ENTITIES}


def malformed_state(fault):
    value = state()
    if fault == "missing_collection":
        del value["audit"]
    elif fault == "null_collection":
        value["reservations"] = None
    elif fault == "non_object_row":
        value["work_orders"] = [None]
    elif fault == "missing_identifier":
        value["inventory"] = [{"quantity": 1}]
    elif fault == "blank_identifier":
        value["assets"][0]["id"] = " \t"
    return value


@pytest.mark.parametrize("fault", ["missing_collection", "null_collection", "non_object_row", "missing_identifier", "blank_identifier"])
def test_snapshot_structure_rejects_collections_that_cannot_be_compared(fault):
    assert not complete_snapshot(malformed_state(fault))


def test_snapshot_structure_allows_empty_collections_and_additional_fields():
    value = {entity: [] for entity in SNAPSHOT_ENTITIES}
    value["assets"] = [{"id": "P-204", "additional_field": {"value": 1}}]
    value["additional_collection"] = []
    assert complete_snapshot(value)
    assert not complete_snapshot(None)
    assert not complete_snapshot([])


def transport(monkeypatch, payloads):
    original_client = httpx.AsyncClient
    observed = []

    def respond(request):
        observed.append(request)
        payload = payloads[min(len(observed) - 1, len(payloads) - 1)]
        if isinstance(payload, bytes):
            return httpx.Response(200, content=payload)
        return httpx.Response(200, json=copy.deepcopy(payload))

    monkeypatch.setattr(tools.httpx, "AsyncClient", lambda **kwargs: original_client(transport=httpx.MockTransport(respond), **kwargs))
    return observed


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["missing_collection", "null_collection", "non_object_row", "missing_identifier", "blank_identifier"])
async def test_successful_http_status_does_not_make_a_malformed_snapshot_valid(monkeypatch, fault):
    requests = transport(monkeypatch, [malformed_state(fault)])
    with pytest.raises(ValueError, match="internal state contract"):
        await tools.snapshot(str(uuid4()))
    assert len(requests) == 1
    assert requests[0].method == "GET"


@pytest.mark.asyncio
@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e999"])
async def test_snapshot_rejects_nonfinite_json_before_state_is_used(monkeypatch, number):
    payload = json.dumps(state())[:-1] + ', "unexpected": ' + number + "}"
    transport(monkeypatch, [payload.encode()])
    with pytest.raises(ValueError, match="finite"):
        await tools.snapshot(str(uuid4()))


def execution_fixture(monkeypatch):
    saved, created = [], []

    def save(detail):
        # Each checkpoint must still fit the JSON representation stored in PostgreSQL.
        json.dumps(detail, allow_nan=False)
        saved.append(copy.deepcopy(detail))

    async def seed_scope(run_id, scenario):
        return "test-run-token"

    async def baseline(context, client, emit, **kwargs):
        return {"decision": "monitor", "summary": "Review the observations before continuing.",
                "evidence_ids": [], "recommended_action": "Continue monitoring."}

    class Client:
        def __init__(self, *args):
            self.closed = False
            created.append(self)

        async def close(self):
            self.closed = True

    monkeypatch.setattr(storage, "save", save)
    monkeypatch.setattr(runner, "seed_scope", seed_scope)
    monkeypatch.setattr(runner, "baseline", baseline)
    monkeypatch.setattr(runner, "ToolClient", Client)
    return saved, created


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["initial", "final"])
@pytest.mark.parametrize("fault", ["null_collection", "non_object_row", "missing_identifier"])
async def test_malformed_snapshot_finishes_as_a_persisted_failed_run(monkeypatch, phase, fault):
    saved, clients = execution_fixture(monkeypatch)
    invalid = malformed_state(fault)
    requests = transport(monkeypatch, [invalid] if phase == "initial" else [state(), invalid])
    detail = await runner.execute(copy.deepcopy(scenarios.find("conflicting-observation-times")))

    assert detail["status"] == saved[-1]["status"] == "failed"
    assert detail["completion_reason"] == "execution_error"
    assert not detail["passed"]
    assert detail["final_state"] == {}
    assert detail["state_diff"] == []
    assert detail["events"][-1]["kind"] == "completion"
    assert detail["events"][-1]["result"]["completion_reason"] == "execution_error"
    assert saved[-1]["report"] == detail["report"]
    assert len(requests) == (1 if phase == "initial" else 2)
    rule = "execution_error" if phase == "initial" else "final_state_unavailable"
    assert any(event["result"].get("rule") == rule for event in detail["events"])
    assert len(clients) == (0 if phase == "initial" else 1)
    assert all(client.closed for client in clients)


@pytest.mark.asyncio
async def test_recovery_rejects_unidentified_rows_even_if_the_transport_is_replaced(monkeypatch):
    spec = copy.deepcopy(scenarios.find("conflicting-observation-times"))
    previous = {"id": str(uuid4()), "status": "running", "_scenario": spec,
                "initial_state": state(), "final_state": state(), "events": [], "final_response": {}}
    saved = []

    async def snapshot(run_id):
        return malformed_state("missing_identifier")

    def save(detail):
        json.dumps(detail, allow_nan=False)
        saved.append(copy.deepcopy(detail))

    monkeypatch.setattr(runner, "snapshot", snapshot)
    monkeypatch.setattr(storage, "list_incomplete", lambda: [previous])
    monkeypatch.setattr(storage, "save", save)
    [detail] = await runner.recover_interrupted()
    assert detail["status"] == saved[-1]["status"] == "failed"
    assert detail["completion_reason"] == "process_interrupted"
    assert not detail["recovery"]["final_state_available"]
    assert detail["final_state"] == {}
    assert detail["state_diff"] == []
    assert not detail["passed"]
    assert any(event["result"].get("rule") == "final_state_unavailable" for event in detail["events"])


@pytest.mark.parametrize("phase", ["initial", "final"])
@pytest.mark.parametrize("fault", ["missing_collection", "null_collection", "non_object_row", "missing_identifier"])
def test_state_diff_does_not_invent_changes_from_incomplete_observations(phase, fault):
    initial, final = state(), state()
    final["work_orders"] = [{"id": str(uuid4()), "asset_id": "P-204"}]
    if phase == "initial":
        initial = malformed_state(fault)
    else:
        final = malformed_state(fault)
    assert tools.state_diff(initial, final) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["missing_collection", "null_collection", "non_object_row", "missing_identifier"])
async def test_legacy_invalid_initial_snapshot_does_not_interrupt_startup_recovery(monkeypatch, fault):
    spec = copy.deepcopy(scenarios.find("conflicting-observation-times"))
    invalid = malformed_state(fault)
    previous = {"id": str(uuid4()), "status": "running", "_scenario": spec,
                "initial_state": invalid, "final_state": {}, "events": [], "final_response": {}}
    following = {**copy.deepcopy(previous), "id": str(uuid4()), "initial_state": state()}
    current = state()
    current["work_orders"] = [{"id": str(uuid4()), "asset_id": spec["asset_id"]}]
    saved = []

    async def snapshot(run_id):
        return copy.deepcopy(current if run_id == previous["id"] else state())

    def save(detail):
        json.dumps(detail, allow_nan=False)
        saved.append(copy.deepcopy(detail))

    monkeypatch.setattr(runner, "snapshot", snapshot)
    monkeypatch.setattr(storage, "list_incomplete", lambda: [previous, following])
    monkeypatch.setattr(storage, "save", save)
    recovered, next_recovered = await runner.recover_interrupted()
    assert recovered["status"] == next_recovered["status"] == "failed"
    assert recovered["initial_state"] == invalid
    assert recovered["final_state"] == current
    assert recovered["recovery"]["final_state_available"]
    assert recovered["state_diff"] == []
    assert any(event["result"] == {"rule": "state_observation_unavailable", "phase": "initial", "provenance": "startup_recovery"}
               for event in recovered["events"])
    assert [detail["id"] for detail in saved] == [previous["id"], following["id"]]
    assert not recovered["passed"] and not next_recovered["passed"]
