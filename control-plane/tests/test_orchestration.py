"""Orchestration boundary tests; provider responses here are local test fixtures."""
import copy
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from lab import app as api
from lab import providers, runner, scenarios, storage
from lab.tools import ExecutionBudgetExceeded


def specification(identifier="conflicting-observation-times"):
    return copy.deepcopy(scenarios.find(identifier))


def context(spec):
    return {key: spec[key] for key in ("request", "actor", "asset_id", "clock")}


class FixtureTools:
    def __init__(self, spec, overrides=None, emit=None):
        self.spec, self.overrides, self.emit = spec, overrides or {}, emit
        self.calls = []

    async def call(self, name, arguments, **kwargs):
        self.calls.append((name, copy.deepcopy(arguments)))
        seed = self.spec["seed"]
        asset = next(row for row in seed["assets"] if row["id"] == self.spec["asset_id"])
        results = {
            "get_asset": {"data": asset},
            "query_telemetry": {"data": {"readings": [row for row in seed["telemetry"] if row["asset_id"] == asset["id"]]}},
            "get_manual_revision": {"data": {"manuals": [row for row in seed["manuals"] if row["asset_id"] == asset["id"]]}},
            "request_supervisor_approval": {"data": {"id": str(uuid4()), "status": "pending"}},
            "search_inventory": {"data": {"items": seed["inventory"]}},
            "reserve_part": {"data": {"id": str(uuid4())}},
            "list_technicians": {"data": {"technicians": [row for row in seed["technicians"] if row["facility_id"] == asset["facility_id"] and row["tenant_id"] == asset["tenant_id"]]}},
            "create_work_order": {"data": {"id": str(uuid4())}},
        }
        result = copy.deepcopy(self.overrides.get(name, results.get(name, {"error": {"code": "UNKNOWN_TOOL"}})))
        if self.emit:
            self.emit(kind="tool", state="call_tool", tool=name, arguments=arguments,
                      status=200 if "data" in result else 503, result=result, response_valid=True)
        return result


@pytest.mark.asyncio
@pytest.mark.parametrize("code,decision", [("NOT_FOUND", "access_denied"), ("RUN_SCOPE_DENIED", "access_denied"),
                                           ("TIMEOUT", "insufficient_evidence"), ("RESPONSE_CONTRACT", "insufficient_evidence")])
async def test_asset_access_denial_is_distinct_from_unavailable_evidence(code, decision):
    spec = specification()
    tools = FixtureTools(spec, {"get_asset": {"error": {"code": code}}})
    answer = await providers.baseline(context(spec), tools, lambda **fields: None)
    assert answer["decision"] == decision
    assert answer["evidence_ids"] == []
    assert [name for name, _ in tools.calls] == ["get_asset"]


@pytest.mark.asyncio
async def test_baseline_uses_retrieved_current_evidence_and_qualified_technician():
    spec = specification("certified-technician-scheduling")
    tools = FixtureTools(spec)
    answer = await providers.baseline(context(spec), tools, lambda **fields: None)
    assert answer["evidence_ids"] == spec["expectations"]["required_evidence"]
    draft = next(args for name, args in tools.calls if name == "create_work_order")
    assert draft["asset_id"] == "F-310"
    assert draft["evidence_ids"] == answer["evidence_ids"]
    assert draft["technician_id"] == "tech-lcho"
    assert not any(name == "set_asset_status" for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_missing_current_evidence_stops_before_workflow_mutation():
    spec = specification("overheating-stale-sensor")
    tools = FixtureTools(spec, {"query_telemetry": {"data": {"readings": [spec["seed"]["telemetry"][0]]}}})
    answer = await providers.baseline(context(spec), tools, lambda **fields: None)
    assert answer["decision"] == "insufficient_evidence"
    assert answer["evidence_ids"] == []
    assert not any(name in {"reserve_part", "request_supervisor_approval", "create_work_order", "set_asset_status"} for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_failed_approval_request_is_not_reported_as_pending():
    spec = specification("overheating-stale-sensor")
    tools = FixtureTools(spec, {"request_supervisor_approval": {"error": {"code": "TIMEOUT"}}})
    answer = await providers.baseline(context(spec), tools, lambda **fields: None)
    assert answer["decision"] == "insufficient_evidence"
    assert "Supervisor approval is pending" not in answer["summary"]
    assert "could not be recorded" in answer["summary"]
    assert any(name == "create_work_order" for name, _ in tools.calls)


def compatible_fixture(monkeypatch, handler, max_steps=2):
    """Use httpx's in-process transport: no provider or external network is contacted."""
    original_client = httpx.AsyncClient
    requests = []

    async def respond(request):
        requests.append(request)
        return handler(request, len(requests))

    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **kwargs: original_client(transport=httpx.MockTransport(respond), **kwargs))
    monkeypatch.setattr(providers, "MAX_STEPS", max_steps)
    monkeypatch.setenv("MODEL_BASE_URL", "https://provider.example.invalid/v1")
    monkeypatch.setenv("MODEL_NAME", "unit-fixture")
    monkeypatch.setenv("MODEL_API_KEY", "provider-key-never-in-trace")
    return requests


def model_reply(message):
    return httpx.Response(200, json={"choices": [{"message": message}]})


def tool_request(count=1, arguments=None):
    return {"tool_calls": [{"id": f"fixture-{index}", "type": "function", "function": {
        "name": "get_asset", "arguments": json.dumps({"asset_id": "P-204"} if arguments is None else arguments)}} for index in range(count)]}


@pytest.mark.asyncio
async def test_compatible_provider_step_limit_stops_infinite_tool_requests(monkeypatch):
    requests = compatible_fixture(monkeypatch, lambda request, index: model_reply(tool_request()), max_steps=2)
    tools, events = FixtureTools(specification()), []
    with pytest.raises(RuntimeError, match="step budget exhausted"):
        await providers.compatible(context(tools.spec), tools, lambda **event: events.append(event))
    assert len(requests) == 2
    assert len(tools.calls) == 2
    assert "provider-key-never-in-trace" not in json.dumps(events)
    assert all(event["result"].get("model") == "unit-fixture" for event in events)
    user_context = json.loads(json.loads(requests[0].content)["messages"][1]["content"])
    assert not {"seed", "expectations", "faults", "rubric", "golden_tools"} & user_context.keys()


@pytest.mark.asyncio
async def test_compatible_provider_rejects_excess_actions_before_dispatch(monkeypatch):
    requests = compatible_fixture(monkeypatch, lambda request, index: model_reply(tool_request(5)))
    tools = FixtureTools(specification())
    with pytest.raises(ValueError, match="too many parallel actions"):
        await providers.compatible(context(tools.spec), tools, lambda **fields: None)
    assert len(requests) == 1
    assert tools.calls == []


@pytest.mark.asyncio
async def test_compatible_provider_rejects_nonobject_arguments(monkeypatch):
    compatible_fixture(monkeypatch, lambda request, index: model_reply(tool_request(arguments=[])))
    tools = FixtureTools(specification())
    with pytest.raises(ValueError, match="arguments must be an object"):
        await providers.compatible(context(tools.spec), tools, lambda **fields: None)
    assert tools.calls == []


@pytest.mark.asyncio
async def test_compatible_provider_rejects_oversize_response(monkeypatch):
    compatible_fixture(monkeypatch, lambda request, index: httpx.Response(200, content=b" " * 262145))
    tools = FixtureTools(specification())
    with pytest.raises(ValueError, match="size limit"):
        await providers.compatible(context(tools.spec), tools, lambda **fields: None)
    assert tools.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("final", [{"decision": "monitor"}, {"decision": "monitor", "summary": "ok", "recommended_action": "monitor", "evidence_ids": [123]}])
async def test_compatible_provider_requires_structured_final_answer(monkeypatch, final):
    compatible_fixture(monkeypatch, lambda request, index: model_reply({"content": json.dumps(final)}))
    tools = FixtureTools(specification())
    with pytest.raises(ValueError, match="response contract"):
        await providers.compatible(context(tools.spec), tools, lambda **fields: None)


@pytest.mark.asyncio
@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"])
@pytest.mark.parametrize("surface", ["final", "tool_arguments"])
async def test_compatible_provider_rejects_nonfinite_json_before_return_or_dispatch(monkeypatch, number, surface):
    if surface == "final":
        message = {"content": '{"decision":"monitor","summary":"Reviewed","evidence_ids":[],"recommended_action":"Monitor","confidence":' + number + '}'}
    else:
        message = tool_request()
        message["tool_calls"][0]["function"]["arguments"] = '{"asset_id":"P-204","quantity":' + number + '}'
    compatible_fixture(monkeypatch, lambda request, index: model_reply(message))
    tools = FixtureTools(specification())
    with pytest.raises(ValueError, match="finite"):
        await providers.compatible(context(tools.spec), tools, lambda **fields: None)
    assert tools.calls == []


@pytest.mark.asyncio
async def test_runner_records_nonfinite_provider_reply_as_a_failed_run(monkeypatch):
    spec, saved, _, _ = runner_fixture(monkeypatch)
    message = {"content": '{"decision":"monitor","summary":"Reviewed","evidence_ids":[],"recommended_action":"Monitor","confidence":NaN}'}
    compatible_fixture(monkeypatch, lambda request, index: model_reply(message))

    def save(detail):
        # This matches PostgreSQL's finite-number restriction at the storage boundary.
        json.dumps(detail, allow_nan=False)
        saved.append(copy.deepcopy(detail))

    monkeypatch.setattr(runner.storage, "save", save)
    detail = await runner.execute(spec, "openai-compatible")
    assert detail["status"] == "failed"
    assert detail["completion_reason"] == "execution_error"
    assert saved[-1]["status"] == "failed"
    assert any(event.get("result", {}).get("error_type") == "ValueError" for event in detail["events"])


def runner_fixture(monkeypatch, cleanup_error=False):
    spec = specification()
    saved, clients = [], []
    token = "opaque-run-secret-not-persisted"
    snapshot = copy.deepcopy(spec["seed"])
    snapshot.update(reservations=[], work_orders=[], approval_requests=[], audit=[])

    async def seed(run_id, scenario):
        assert scenario == spec
        return token

    async def get_snapshot(run_id):
        return copy.deepcopy(snapshot)

    class Client(FixtureTools):
        def __init__(self, run_id, credential, scenario, emit):
            super().__init__(scenario, emit=emit)
            assert credential == token
            self.closed = False
            clients.append(self)

        async def close(self):
            self.closed = True
            if cleanup_error:
                raise RuntimeError("cleanup exception with sensitive request context")

    monkeypatch.setattr(runner.storage, "save", lambda detail: saved.append(copy.deepcopy(detail)))
    monkeypatch.setattr(runner, "seed_scope", seed)
    monkeypatch.setattr(runner, "snapshot", get_snapshot)
    monkeypatch.setattr(runner, "ToolClient", Client)
    return spec, saved, clients, token


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [
    ExecutionBudgetExceeded("Model step budget exhausted"),
    ExecutionBudgetExceeded("Tool request budget exhausted"),
    TimeoutError(),
])
async def test_execution_limits_persist_a_distinct_budget_completion(monkeypatch, failure):
    spec, saved, clients, _ = runner_fixture(monkeypatch)

    async def exhaust(*args, **kwargs):
        raise failure

    monkeypatch.setattr(runner, "compatible", exhaust)
    detail = await runner.execute(spec, "openai-compatible")
    assert detail["status"] == "failed" and not detail["passed"]
    assert detail["completion_reason"] == "budget_exhausted"
    assert detail["events"][-1]["result"]["completion_reason"] == "budget_exhausted"
    assert detail["final_state"]["assets"] == spec["seed"]["assets"]
    assert clients[0].closed
    assert saved[-1]["status"] == "failed"
    assert saved[-1]["completion_reason"] == "budget_exhausted"


@pytest.mark.asyncio
async def test_runner_persists_terminal_state_and_never_exposes_private_spec_or_credential(monkeypatch):
    spec, saved, clients, token = runner_fixture(monkeypatch)
    before = datetime.now(timezone.utc)
    detail = await runner.execute(spec)
    after = datetime.now(timezone.utc)
    assert detail["status"] == "completed"
    assert detail["passed"]
    assert saved[0]["status"] == "running"
    assert saved[-1]["status"] == "completed"
    assert clients[0].closed
    assert "_scenario" not in detail
    assert saved[-1]["_scenario"] == spec
    assert token not in json.dumps(saved)
    assert detail["events"][-1]["kind"] == "completion"
    for event in detail["events"]:
        started, finished = datetime.fromisoformat(event["started_at"]), datetime.fromisoformat(event["finished_at"])
        assert before <= started <= finished <= after
        assert datetime.fromisoformat(event["scenario_time"]) == datetime.fromisoformat(spec["clock"].replace("Z", "+00:00")) + timedelta(seconds=event["step"])


@pytest.mark.asyncio
async def test_runner_cleanup_error_still_snapshots_evaluates_and_persists(monkeypatch):
    spec, saved, clients, _ = runner_fixture(monkeypatch, cleanup_error=True)
    detail = await runner.execute(spec)
    assert detail["final_state"]["assets"] == spec["seed"]["assets"]
    assert detail["report"] and saved[-1]["status"] == "completed"
    assert clients[0].closed
    assert any(event["result"].get("rule") == "tool_client_cleanup_failed" for event in detail["events"])
    assert "sensitive request context" not in json.dumps(saved)


@pytest.mark.asyncio
async def test_trace_records_runtime_latency_separately_from_scenario_clock(monkeypatch):
    spec, _, _, _ = runner_fixture(monkeypatch)

    async def answer(context, tools, emit, **kwargs):
        emit(kind="tool", state="call_tool", tool="get_asset", status=200, result={"data": {}}, latency_ms=87.5)
        return {"decision": "monitor", "summary": "Fixture output", "evidence_ids": [], "recommended_action": "Monitor"}

    monkeypatch.setattr(runner, "baseline", answer)
    detail = await runner.execute(spec)
    event = next(event for event in detail["events"] if event["kind"] == "tool")
    elapsed = datetime.fromisoformat(event["finished_at"]) - datetime.fromisoformat(event["started_at"])
    assert elapsed == timedelta(milliseconds=87.5)
    assert datetime.fromisoformat(event["scenario_time"]) == datetime.fromisoformat(spec["clock"].replace("Z", "+00:00")) + timedelta(seconds=event["step"])


@pytest.mark.asyncio
async def test_runner_contains_exception_details_and_retains_failed_run(monkeypatch):
    spec, saved, clients, token = runner_fixture(monkeypatch)

    async def fail(*args, **kwargs):
        raise RuntimeError(f"Bearer {token}; synthetic.person@example.invalid")

    monkeypatch.setattr(runner, "baseline", fail)
    detail = await runner.execute(spec)
    assert detail["status"] == "failed" and not detail["passed"]
    assert detail["completion_reason"] == "execution_error"
    assert clients[0].closed
    assert saved[-1]["status"] == "failed"
    assert token not in json.dumps(saved)
    assert "synthetic.person@example.invalid" not in json.dumps(saved)
    assert any(event["result"].get("error_type") == "RuntimeError" for event in detail["events"])


@pytest.mark.asyncio
async def test_runner_redacts_final_output_and_fails_unretrieved_citations(monkeypatch):
    spec, saved, _, token = runner_fixture(monkeypatch)

    async def answer(*args, **kwargs):
        return {"decision": "monitor", "summary": f"Contact synthetic.person@example.invalid or Bearer {token}",
                "evidence_ids": ["fabricated-reading"], "recommended_action": "Monitor", "employee_contact": {"phone": "555-010-0199"}}

    monkeypatch.setattr(runner, "baseline", answer)
    detail = await runner.execute(spec)
    assert not detail["passed"]
    assert token not in json.dumps(saved)
    assert "synthetic.person@example.invalid" not in json.dumps(saved)
    assert "555-010-0199" not in json.dumps(saved)
    assert detail["final_response"]["employee_contact"] == "[REDACTED]"
    assert any(event["result"].get("rule") == "agent_sensitive_disclosure" for event in detail["events"])
    assert not next(group for group in detail["report"]["criteria"] if group["id"] == "evidence_freshness")["passed"]


def test_replay_uses_stored_scenario_snapshot_and_requires_reviewer(monkeypatch):
    original = specification()
    run_id = str(uuid4())
    previous = {"id": run_id, "_scenario": original, "provider": "baseline"}
    calls = []
    monkeypatch.setattr(api.storage, "get", lambda identifier: copy.deepcopy(previous))

    async def execute(scenario, provider, replay_of=None):
        calls.append((scenario, provider, replay_of))
        return {"id": str(uuid4()), "replay_of": replay_of}

    monkeypatch.setattr(api, "execute", execute)
    # No lifespan context: storage and execution are isolated fixtures here.
    client = TestClient(api.app)
    assert client.post(f"/api/runs/{run_id}/replay").status_code == 401
    assert calls == []
    response = client.post(f"/api/runs/{run_id}/replay", headers={"Authorization": f"Bearer {api.REVIEW_KEY}"})
    assert response.status_code == 200
    assert response.json()["id"] != run_id
    assert response.json()["replay_of"] == run_id
    assert calls == [(original, "baseline", run_id)]


def test_review_routes_normalize_uuid_aliases_for_lookups_links_and_exports(monkeypatch):
    run_id = str(uuid4())
    previous = {"id": run_id, "_scenario": specification(), "provider": "baseline", "status": "completed"}
    looked_up, executions = [], []

    def get(identifier):
        looked_up.append(identifier)
        return copy.deepcopy(previous) if identifier == run_id else None

    async def execute(scenario, provider, replay_of=None):
        executions.append(replay_of)
        return {"id": str(uuid4()), "replay_of": replay_of}

    monkeypatch.setattr(api.storage, "get", get)
    monkeypatch.setattr(api, "execute", execute)
    client = TestClient(api.app)
    headers = {"Authorization": f"Bearer {api.REVIEW_KEY}"}
    for alias in (run_id.upper(), "urn:uuid:" + run_id, "{" + run_id + "}"):
        assert client.get(f"/api/runs/{alias}").json()["id"] == run_id
        exported = client.get(f"/api/runs/{alias}/export")
        assert exported.status_code == 200
        assert exported.headers["content-disposition"] == f'attachment; filename="run-{run_id}.json"'
        replayed = client.post(f"/api/runs/{alias}/replay", headers=headers)
        assert replayed.status_code == 200 and replayed.json()["replay_of"] == run_id
    assert set(looked_up) == {run_id}
    assert executions == [run_id] * 3


def test_review_mutations_reject_extra_identity_fields_and_unknown_providers():
    client = TestClient(api.app)
    headers = {"Authorization": f"Bearer {api.REVIEW_KEY}"}
    assert client.post("/api/runs", headers=headers, json={"scenario_id": "example", "provider": "privileged-provider"}).status_code == 422
    assert client.post("/api/runs", headers=headers, json={"scenario_id": "example", "role": "supervisor"}).status_code == 422


def test_storage_connection_and_queries_have_bounded_waits(monkeypatch):
    calls = []
    marker = object()
    monkeypatch.setattr(storage.psycopg, "connect", lambda *args, **kwargs: calls.append((args, kwargs)) or marker)
    assert storage.connect() is marker
    assert calls[0][1]["connect_timeout"] == 5
    assert calls[0][1]["options"] == "-c statement_timeout=10000"


@pytest.mark.parametrize("path,value", [
    (("expectations", "decision"), "probably_ok"),
    (("expectations", "decision"), []),
    (("expectations", "work_orders"), True),
    (("expectations", "max_calls"), 41),
    (("expectations", "required_evidence"), ["unseeded-reading"]),
    (("expectations", "required_tools"), ["run_sql"]),
    (("expectations", "technician_id"), "tech-rlee"),
    (("actor", "role"), "administrator"),
    (("actor", "facility_id"), "plant-east"),
    (("clock",), "2026-10-17T14:00:00"),
    (("category",), "ungraded"),
    (("rubric", 0, "weight"), 31),
    (("rubric", 0, "weight"), float("inf")),
    (("rubric", 1, "id"), "final_state"),
    (("seed", "inventory", 0, "quantity"), -1),
    (("seed", "manuals", 0, "required_part_id"), "unseeded-part"),
    (("seed", "telemetry", 0, "observed_at"), "Friday afternoon"),
    (("faults",), [{"tool": "get_asset", "kind": "hide_everything", "attempt": 1}]),
    (("faults",), [{"tool": "get_asset", "kind": "rate_limit", "attempt": 1}, {"tool": "get_asset", "kind": "timeout_before", "attempt": 1}]),
])
def test_invalid_trusted_specifications_fail_before_seeding(path, value):
    spec = specification("overheating-stale-sensor")
    row = spec
    for key in path[:-1]:
        row = row[key]
    row[path[-1]] = value
    with pytest.raises(ValueError, match="Invalid scenario"):
        scenarios.validate(spec, "edited.json")


def test_valid_custom_weights_preserve_known_groups_and_total():
    spec = specification()
    for group, weight in zip(spec["rubric"], [40, 20, 15, 15, 10]):
        group["weight"] = weight
    assert scenarios.validate(spec) is spec


def test_duplicate_scenario_identifiers_are_rejected_on_load(monkeypatch, tmp_path):
    spec = specification()
    for filename in ("one.json", "two.json"):
        (tmp_path / filename).write_text(json.dumps(spec), encoding="utf-8")
    monkeypatch.setattr(scenarios, "SCENARIO_DIR", tmp_path)
    with pytest.raises(ValueError, match="Duplicate scenario IDs"):
        scenarios.load_all()


def test_nonascii_reviewer_header_returns_unauthorized():
    client = TestClient(api.app)
    response = client.post("/api/runs", headers={"Authorization": b"Bearer \xff"}, json={"scenario_id": "example"})
    assert response.status_code == 401


def interrupted_fixture():
    spec = specification("lost-work-order-response")
    run_id, order_id, reservation_id = str(uuid4()), str(uuid4()), str(uuid4())
    initial = copy.deepcopy(spec["seed"])
    initial.update(reservations=[], work_orders=[], approval_requests=[], audit=[])
    current = copy.deepcopy(initial)
    current["inventory"][0]["quantity"] -= 1
    current["reservations"] = [{"id": reservation_id, "asset_id": spec["asset_id"], "part_id": "BRG-6309", "quantity": 1}]
    current["approval_requests"] = [{"id": str(uuid4()), "asset_id": spec["asset_id"], "status": "pending"}]
    current["work_orders"] = [{"id": order_id, "asset_id": spec["asset_id"], "title": "Inspect drive bearing", "priority": "urgent",
                               "status": "draft", "evidence_ids": spec["expectations"]["required_evidence"],
                               "technician_id": "tech-lcho", "reservation_id": reservation_id}]
    event = {"id": str(uuid4()), "parent_event_id": None, "correlation_id": f"{run_id}:create",
             "step": 1, "kind": "tool", "state": "call_tool", "tool": "create_work_order",
             "arguments": {"asset_id": spec["asset_id"]}, "status": 504, "response_valid": True,
             "result": {"error": {"code": "TIMEOUT"}}, "attempt": 1, "latency_ms": 9,
             "started_at": spec["clock"], "state_changes": [{"entity": "work_orders", "id": order_id, "before": None, "after": current["work_orders"][0]}]}
    detail = {"id": run_id, "scenario_id": spec["id"], "scenario_name": spec["name"], "category": spec["category"],
              "status": "running", "provider": "baseline", "created_at": spec["clock"], "_scenario": spec,
              "events": [event], "initial_state": initial, "final_state": initial,
              "request": spec["request"], "actor": spec["actor"], "asset_id": spec["asset_id"], "clock": spec["clock"],
              "final_response": {}, "completion_reason": None, "duration_ms": 0}
    return detail, current


@pytest.mark.asyncio
async def test_startup_recovery_preserves_committed_state_and_trace_without_reexecuting(monkeypatch):
    previous, current = interrupted_fixture()
    saved, snapshots = [], []
    monkeypatch.setattr(storage, "list_incomplete", lambda: [copy.deepcopy(previous)] if not saved else [])
    monkeypatch.setattr(storage, "save", lambda detail: saved.append(copy.deepcopy(detail)))

    async def snapshot(run_id):
        snapshots.append(run_id)
        return copy.deepcopy(current)

    def forbidden(*args, **kwargs):
        raise AssertionError("Recovery must not seed, create a client or invoke a provider")

    monkeypatch.setattr(runner, "snapshot", snapshot)
    for name in ("seed_scope", "baseline", "compatible", "ToolClient"):
        monkeypatch.setattr(runner, name, forbidden)
    [recovered] = await runner.recover_interrupted()
    assert snapshots == [previous["id"]]
    assert recovered["status"] == "failed" and not recovered["passed"]
    assert recovered["completion_reason"] == "process_interrupted"
    assert recovered["events"][0] == previous["events"][0]
    assert recovered["events"][-1]["parent_event_id"] == previous["events"][0]["id"]
    assert recovered["events"][-1]["result"]["provenance"] == "startup_recovery"
    assert "scenario_time" in recovered["events"][-1] and "finished_at" in recovered["events"][-1]
    assert recovered["final_state"] == current
    assert len(recovered["final_state"]["work_orders"]) == 1
    assert any(change["entity"] == "work_orders" for change in recovered["state_diff"])
    assert recovered["recovery"]["final_state_available"]
    assert recovered["recovery"]["duration_incomplete"]
    assert "_scenario" not in recovered
    assert saved[-1]["_scenario"] == previous["_scenario"]
    assert await runner.recover_interrupted() == []
    assert len(saved) == 1


@pytest.mark.asyncio
async def test_startup_recovery_marks_missing_snapshot_instead_of_reusing_old_state(monkeypatch):
    previous, _ = interrupted_fixture()
    saved = []
    monkeypatch.setattr(storage, "list_incomplete", lambda: [previous])
    monkeypatch.setattr(storage, "save", lambda detail: saved.append(copy.deepcopy(detail)))

    async def unavailable(run_id):
        raise RuntimeError("Bearer recovery-secret synthetic.person@example.invalid")

    monkeypatch.setattr(runner, "snapshot", unavailable)
    [recovered] = await runner.recover_interrupted()
    assert recovered["status"] == "failed" and not recovered["passed"]
    assert recovered["final_state"] == {}
    assert not recovered["recovery"]["final_state_available"]
    assert any(event["result"].get("rule") == "final_state_unavailable" for event in recovered["events"])
    assert "recovery-secret" not in json.dumps(saved)
    assert "synthetic.person@example.invalid" not in json.dumps(saved)


@pytest.mark.asyncio
async def test_startup_recovery_treats_malformed_snapshot_as_unavailable(monkeypatch):
    previous, _ = interrupted_fixture()
    monkeypatch.setattr(storage, "list_incomplete", lambda: [previous])
    monkeypatch.setattr(storage, "save", lambda detail: None)

    async def malformed(run_id):
        return {"assets": []}

    monkeypatch.setattr(runner, "snapshot", malformed)
    [recovered] = await runner.recover_interrupted()
    assert not recovered["passed"]
    assert not recovered["recovery"]["final_state_available"]
    assert recovered["final_state"] == {}


@pytest.mark.asyncio
async def test_startup_recovery_retains_an_already_recorded_final_answer(monkeypatch):
    previous, current = interrupted_fixture()
    previous["final_response"] = {"decision": "maintenance_required", "summary": "A draft was prepared before interruption.",
                                  "evidence_ids": previous["_scenario"]["expectations"]["required_evidence"],
                                  "recommended_action": "Wait for supervisor authorization."}
    monkeypatch.setattr(storage, "list_incomplete", lambda: [previous])
    monkeypatch.setattr(storage, "save", lambda detail: None)

    async def snapshot(run_id):
        return current

    monkeypatch.setattr(runner, "snapshot", snapshot)
    [recovered] = await runner.recover_interrupted()
    assert recovered["final_response"] == previous["final_response"]
    assert recovered["completion_reason"] == "process_interrupted"
    assert not recovered["passed"]


@pytest.mark.asyncio
async def test_lifespan_recovers_interrupted_records_before_serving(monkeypatch):
    observed = []
    monkeypatch.setattr(storage, "initialize", lambda: observed.append("initialize"))
    monkeypatch.setenv("LAB_SEED_DEMO", "0")

    async def recover():
        observed.append("recover")

    monkeypatch.setattr(api, "recover_interrupted", recover)
    async with api.lifespan(api.app):
        observed.append("serve")
    assert observed == ["initialize", "recover", "serve"]


@pytest.mark.asyncio
async def test_reevaluation_reports_current_and_stored_versions_without_overwriting_history(monkeypatch):
    spec, saved, _, _ = runner_fixture(monkeypatch)
    await runner.execute(spec)
    previous = copy.deepcopy(saved[-1])
    previous["report"].pop("evaluator_version")
    monkeypatch.setattr(storage, "get", lambda identifier: copy.deepcopy(previous))
    writes_before = len(saved)
    client = TestClient(api.app)
    response = client.post(f"/api/runs/{previous['id']}/evaluate", headers={"Authorization": f"Bearer {api.REVIEW_KEY}"})
    assert response.status_code == 200
    assert response.json()["evaluator_version"] == response.headers["X-Evaluator-Version"]
    assert response.headers["X-Original-Evaluator-Version"] == "legacy-unversioned"
    assert len(saved) == writes_before
    assert "evaluator_version" not in previous["report"]


@pytest.mark.asyncio
async def test_controlled_comparison_requires_known_matching_evaluator_versions(monkeypatch):
    spec, saved, _, _ = runner_fixture(monkeypatch)
    await runner.execute(spec)
    left = copy.deepcopy(saved[-1])
    right = copy.deepcopy(left)
    right["id"] = str(uuid4())
    right["report"].pop("evaluator_version")
    records = {left["id"]: left, right["id"]: right}
    monkeypatch.setattr(storage, "get", lambda identifier: copy.deepcopy(records[identifier]))
    client = TestClient(api.app)
    path = f"/api/runs/{left['id']}/compare/{right['id']}"
    assert not client.get(path).json()["comparable"]
    right["report"]["evaluator_version"] = left["report"]["evaluator_version"]
    assert client.get(path).json()["comparable"]
    left["report"].pop("evaluator_version")
    right["report"].pop("evaluator_version")
    assert not client.get(path).json()["comparable"]
