"""Provider protocol fixtures run locally without contacting a model or tool API."""
import copy
import json

import httpx
import pytest

from lab import providers, runner, scenarios


FINAL = {"decision": "monitor", "summary": "Current readings are within approved limits.",
         "evidence_ids": ["reading-1", "manual-1"], "recommended_action": "Continue monitoring."}
CONTEXT = {"request": "Investigate P-204", "asset_id": "P-204", "clock": "2026-10-17T14:00:00Z",
           "actor": {"id": "technician", "role": "technician", "tenant_id": "northstar", "facility_id": "plant-west"}}


def call(identifier="reserve-1", name="reserve_part", arguments=None):
    return {"id": identifier, "type": "function", "function": {"name": name, "arguments": json.dumps(
        {"asset_id": "P-204", "part_id": "BRG-6309", "quantity": 1} if arguments is None else arguments)}}


def reply(message, finish=None):
    choice = {"message": {"role": "assistant", **message}}
    if finish is not None:
        choice["finish_reason"] = finish
    return {"choices": [choice]}


@pytest.fixture
def provider_fixture(monkeypatch):
    original = httpx.AsyncClient
    bodies, requests = [], []

    async def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=bodies[len(requests) - 1])

    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs))
    monkeypatch.setattr(providers, "MAX_STEPS", 3)
    monkeypatch.setenv("MODEL_BASE_URL", "https://local-protocol.example.invalid/v1")
    monkeypatch.setenv("MODEL_NAME", "protocol-fixture")
    monkeypatch.setenv("MODEL_API_KEY", "")
    return bodies, requests


class RecordingTools:
    def __init__(self):
        self.calls = []

    async def call(self, name, arguments):
        self.calls.append((name, arguments))
        return {"data": {"id": "local-result"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", ["missing_id", "duplicate_id", "wrong_type", "missing_function", "missing_name",
                                       "malformed_json", "array_arguments", "nonfinite_arguments", "nontext_arguments"])
async def test_entire_tool_batch_is_validated_before_any_mutation(provider_fixture, defect):
    bodies, _ = provider_fixture
    first, second = call(), call("second", "get_asset", {"asset_id": "P-204"})
    if defect == "missing_id":
        del second["id"]
    elif defect == "duplicate_id":
        second["id"] = first["id"]
    elif defect == "wrong_type":
        second["type"] = "other"
    elif defect == "missing_function":
        del second["function"]
    elif defect == "missing_name":
        del second["function"]["name"]
    else:
        second["function"]["arguments"] = {"malformed_json": "not-json", "array_arguments": "[]",
            "nonfinite_arguments": '{"quantity":NaN}', "nontext_arguments": {"asset_id": "P-204"}}[defect]
    bodies.append(reply({"tool_calls": [first, second]}, "tool_calls"))
    tools = RecordingTools()
    with pytest.raises(ValueError):
        await providers.compatible(CONTEXT, tools, lambda **fields: None)
    assert tools.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("finish,has_calls", [("length", False), ("content_filter", False), ("tool_calls", False),
                                              ("stop", True), ("length", True)])
async def test_explicit_incomplete_or_inconsistent_completion_is_not_accepted(provider_fixture, finish, has_calls):
    bodies, _ = provider_fixture
    message = {"tool_calls": [call()]} if has_calls else {"content": json.dumps(FINAL)}
    bodies.append(reply(message, finish))
    tools = RecordingTools()
    with pytest.raises(ValueError, match="finish reason"):
        await providers.compatible(CONTEXT, tools, lambda **fields: None)
    assert tools.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("message", [
    {"content": json.dumps(FINAL), "refusal": "Unable to comply"},
    {"content": json.dumps(FINAL), "role": "user"},
    {"content": json.dumps(FINAL), "tool_calls": {}},
    {"content": FINAL},
])
async def test_malformed_message_or_refusal_cannot_become_a_successful_final_answer(provider_fixture, message):
    bodies, _ = provider_fixture
    bodies.append(reply(message))
    with pytest.raises(ValueError):
        await providers.compatible(CONTEXT, RecordingTools(), lambda **fields: None)


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("summary", " "), ("recommended_action", ""), ("decision", [])])
async def test_final_answer_requires_meaningful_text_and_a_known_decision(provider_fixture, field, value):
    bodies, _ = provider_fixture
    final = {**FINAL, field: value}
    bodies.append(reply({"content": json.dumps(final)}, "stop"))
    with pytest.raises(ValueError, match="response contract"):
        await providers.compatible(CONTEXT, RecordingTools(), lambda **fields: None)


@pytest.mark.asyncio
async def test_valid_multi_tool_turn_preserves_call_ids_and_accepts_a_completed_answer(provider_fixture):
    bodies, requests = provider_fixture
    calls = [call(), call("asset-2", "get_asset", {"asset_id": "P-204"})]
    bodies.extend([reply({"tool_calls": calls}, "tool_calls"), reply({"content": json.dumps(FINAL)}, "stop")])
    tools = RecordingTools()
    answer = await providers.compatible(CONTEXT, tools, lambda **fields: None)
    assert answer == FINAL
    assert [name for name, _ in tools.calls] == ["reserve_part", "get_asset"]
    assert [message["tool_call_id"] for message in requests[1]["messages"] if message["role"] == "tool"] == ["reserve-1", "asset-2"]
    assert requests[1]["messages"][2]["tool_calls"] == calls
    assert "Model turn limit: 3." in requests[0]["messages"][0]["content"]


@pytest.mark.asyncio
async def test_malformed_batch_leaves_a_persisted_failed_run_without_operational_actions(provider_fixture, monkeypatch):
    bodies, _ = provider_fixture
    malformed = call("missing-id", "get_asset", {"asset_id": "P-204"})
    del malformed["id"]
    bodies.append(reply({"tool_calls": [call(), malformed]}, "tool_calls"))
    spec = scenarios.find("conflicting-observation-times")
    state = copy.deepcopy(spec["seed"])
    state.update(reservations=[], work_orders=[], approval_requests=[], audit=[])
    saved, clients = [], []

    async def seed(run_id, specification):
        return "test-run-token"

    async def snapshot(run_id):
        return copy.deepcopy(state)

    class Client(RecordingTools):
        def __init__(self, *args):
            super().__init__()
            clients.append(self)

        async def close(self):
            pass

    monkeypatch.setattr(runner, "seed_scope", seed)
    monkeypatch.setattr(runner, "snapshot", snapshot)
    monkeypatch.setattr(runner, "ToolClient", Client)
    monkeypatch.setattr(runner.storage, "save", lambda detail: saved.append(copy.deepcopy(detail)))
    detail = await runner.execute(spec, "openai-compatible")
    assert clients[0].calls == []
    assert detail["status"] == saved[-1]["status"] == "failed"
    assert detail["completion_reason"] == "execution_error"
    assert not detail["report"]["passed"]
    assert detail["initial_state"] == detail["final_state"] == state
    assert "test-run-token" not in json.dumps(saved)
