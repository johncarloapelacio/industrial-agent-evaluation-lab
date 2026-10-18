import copy
from uuid import uuid4
import pytest
import httpx
import lab.tools as tool_module
from lab.tools import ExecutionBudgetExceeded, ToolClient


ACTOR = {"facility_id": "west", "tenant_id": "tenant-a"}
ASSET = {"id": "P-204", "name": "Pump", "notes": "", "status": "running", **ACTOR}
READING = {"id": "T1", "asset_id": "P-204", "observed_at": "2026-10-17T13:52:00Z", "temperature": 89.2,
           "temperature_unit": "C", "vibration": 5.4, "vibration_unit": "mm/s", "sensor_status": "valid"}
MANUAL = {"id": "M7", "asset_id": "P-204", "revision": "R7", "approved": True,
          "effective_at": "2026-01-01T00:00:00Z", "temperature_limit_c": 80, "vibration_limit_mm_s": 4.5,
          "procedure": "Inspect bearing", "required_part_id": "BRG-6309"}


def test_scoped_asset_response_requires_all_technical_fields_and_identity_binding():
    assert ToolClient.valid_response("get_asset", {"data": ASSET}, {"asset_id": "P-204"}, ACTOR)
    assert not ToolClient.valid_response("get_asset", {"data": {"id": "malformed"}})
    assert not ToolClient.valid_response("get_asset", {"data": {**ASSET, "tenant_id": "another"}}, {"asset_id": "P-204"}, ACTOR)
    assert not ToolClient.valid_response("get_asset", {"data": ASSET}, {"asset_id": "P-088"}, ACTOR)


@pytest.mark.parametrize("field,value", [("temperature", "89"), ("vibration", True), ("observed_at", "not-a-date"), ("asset_id", "P-OTHER")])
def test_nested_malformed_telemetry_is_not_returned_to_provider(field, value):
    reading = {**READING, field: value}
    payload = {"data": {"readings": [reading], "as_of": "2026-10-17T14:00:00Z"}}
    assert not ToolClient.valid_response("query_telemetry", payload, {"asset_id": "P-204"}, ACTOR)


@pytest.mark.parametrize("field,value", [("approved", "true"), ("temperature_limit_c", None), ("vibration_limit_mm_s", float("inf")), ("effective_at", "yesterday")])
def test_nested_malformed_manual_is_rejected(field, value):
    assert not ToolClient.valid_response("get_manual_revision", {"data": {"manuals": [{**MANUAL, field: value}]}})


def test_empty_real_evidence_collections_are_valid_and_unknown_units_remain_domain_data():
    assert ToolClient.valid_response("query_telemetry", {"data": {"readings": [], "as_of": "2026-10-17T14:00:00Z"}})
    assert ToolClient.valid_response("query_telemetry", {"data": {"readings": [{**READING, "temperature_unit": "unknown"}], "as_of": "2026-10-17T14:00:00Z"}})
    assert ToolClient.valid_response("get_manual_revision", {"data": {"manuals": []}})


def test_supported_technical_text_is_complete_at_the_api_field_limits():
    procedure_tail = " FINAL-SAFETY-STEP!"
    notes_tail = " FINAL-NOTE-CHECK"
    procedure = "P" * (30000 - len(procedure_tail)) + procedure_tail
    notes = "N" * (20000 - len(notes_tail)) + notes_tail
    clean_manual = tool_module.sanitize({"data": {"manuals": [{**MANUAL, "procedure": procedure}]}})
    clean_asset = tool_module.sanitize({"data": {**ASSET, "notes": notes}})
    assert clean_manual["data"]["manuals"][0]["procedure"] == procedure
    assert clean_asset["data"]["notes"] == notes
    assert ToolClient.valid_response("get_manual_revision", clean_manual)
    assert ToolClient.valid_response("get_asset", clean_asset)
    clean_manual["data"]["manuals"][0]["procedure"] = "x" * (tool_module.MAX_TEXT_LENGTH + 1)
    clean_asset["data"]["notes"] = "x" * (tool_module.MAX_TEXT_LENGTH + 1)
    assert not ToolClient.valid_response("get_manual_revision", clean_manual)
    assert not ToolClient.valid_response("get_asset", clean_asset)


def test_mutation_response_requires_uuid_and_exact_reserved_part_and_quantity():
    args = {"asset_id": "P-204", "part_id": "BRG-6309", "quantity": 1}
    payload = {"data": {"id": str(uuid4()), **args}}
    assert ToolClient.valid_response("reserve_part", payload, args)
    malformed = copy.deepcopy(payload)
    malformed["data"]["id"] = "malformed"
    assert not ToolClient.valid_response("reserve_part", malformed, args)
    assert not ToolClient.valid_response("reserve_part", {"data": {**payload["data"], "part_id": "wrong-bearing"}}, args)
    assert not ToolClient.valid_response("reserve_part", {"data": {**payload["data"], "quantity": 2}}, args)


def test_committed_work_order_response_accepts_a_canonical_uuid_alias():
    reservation = "AABBCCDD-1234-4ABC-8DEF-0123456789AB"
    arguments = {"asset_id": "P-204", "title": "Inspect bearing", "priority": "urgent",
                 "evidence_ids": ["T1", "M7"], "reservation_id": reservation}
    result = {"data": {**arguments, "id": str(uuid4()), "status": "draft",
                       "reservation_id": reservation.lower()}}
    assert ToolClient.valid_response("create_work_order", result, arguments)
    assert arguments["reservation_id"] == reservation


def test_inventory_and_technician_rows_validate_types_and_tenant():
    assert not ToolClient.valid_response("search_inventory", {"data": {"items": [{"id": "BRG", "name": "Bearing", "quantity": -1, **ACTOR}]}})
    assert not ToolClient.valid_response("list_technicians", {"data": {"technicians": [{"id": "T", "name": "Avery", "available": "yes", "certifications": [], **ACTOR}]}})


@pytest.mark.asyncio
async def test_request_budget_blocks_before_network_dispatch():
    client = ToolClient(str(uuid4()), "unused", {"actor": ACTOR}, lambda **kwargs: kwargs)
    client.dispatched = 40
    try:
        with pytest.raises(ExecutionBudgetExceeded, match="budget"):
            await client.call("get_asset", {"asset_id": "P-204"})
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_snapshot_outage_cannot_erase_a_dispatched_mutation(monkeypatch):
    events = []

    def emit(**fields):
        event = {"id": f"event-{len(events)}", **fields}
        events.append(event)
        return event

    async def unavailable(_run):
        raise httpx.ReadTimeout("State snapshot unavailable")

    monkeypatch.setattr(tool_module, "snapshot", unavailable)
    client = ToolClient(str(uuid4()), "unused", {"actor": ACTOR}, emit)
    await client.http.aclose()
    args = {"asset_id": "P-204", "part_id": "BRG-6309", "quantity": 1}
    client.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(201, json={"data": {"id": str(uuid4()), **args}})))
    try:
        response = await client.call("reserve_part", args)
        assert response["data"]["part_id"] == "BRG-6309"
        tool_events = [event for event in events if event["kind"] == "tool"]
        assert len(tool_events) == 1
        assert tool_events[0]["status"] == 201
        failures = [event for event in events if event["kind"] == "validation"]
        assert {event["result"]["phase"] for event in failures} == {"before", "after"}
        assert all(event["parent_event_id"] == tool_events[0]["id"] for event in failures)
    finally:
        await client.close()


def test_api_trimmed_arguments_bind_to_normalized_responses_without_losing_raw_input():
    args = {"asset_id": " P-204 ", "title": "  Inspect pump  ", "priority": "urgent", "evidence_ids": [" T1 ", " M7 "],
            "technician_id": " tech-one "}
    original = copy.deepcopy(args)
    payload = {"data": {"id": str(uuid4()), "asset_id": "P-204", "title": "Inspect pump", "priority": "urgent",
                        "status": "draft", "evidence_ids": ["T1", "M7"], "technician_id": "tech-one", "reservation_id": None}}
    assert ToolClient.valid_response("create_work_order", payload, args, ACTOR)
    assert args == original
    assert ToolClient.valid_response("get_asset", {"data": ASSET}, {"asset_id": " P-204 "}, ACTOR)
    assert ToolClient.valid_response("reserve_part", {"data": {"id": str(uuid4()), "asset_id": "P-204", "part_id": "BRG-6309", "quantity": 1}},
                                     {"asset_id": " P-204 ", "part_id": " BRG-6309 ", "quantity": 1}, ACTOR)


@pytest.mark.asyncio
async def test_sensitive_argument_redaction_retains_agent_attempt_provenance(monkeypatch):
    events = []

    def emit(**fields):
        event = {"id": f"event-{len(events)}", **fields}
        events.append(event)
        return event

    async def snapshot(_run):
        return {key: [] for key in ("assets", "telemetry", "manuals", "inventory", "technicians", "reservations", "work_orders", "approval_requests", "audit")}

    monkeypatch.setattr(tool_module, "snapshot", snapshot)
    client = ToolClient(str(uuid4()), "unused", {"actor": ACTOR}, emit)
    await client.http.aclose()
    client.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(422, json={"error": {"code": "SENSITIVE_CONTENT"}})))
    try:
        await client.call("request_supervisor_approval", {"asset_id": "P-204", "reason": "Call synthetic.person@example.invalid"})
        tool_event = next(event for event in events if event["kind"] == "tool")
        disclosure = next(event for event in events if event.get("result", {}).get("rule") == "agent_sensitive_disclosure")
        assert disclosure["parent_event_id"] == tool_event["id"]
        assert disclosure["result"]["surface"] == "tool_arguments"
        assert "synthetic.person@example.invalid" not in str(events)
        assert disclosure["result"]["redactions"][0]["path"] == "arguments.reason"
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("number", [float("nan"), float("inf"), float("-inf")])
async def test_nonfinite_arguments_have_a_durable_validation_trace_without_dispatch(monkeypatch, number):
    events, requests = [], []

    def emit(**fields):
        import json
        json.dumps(fields, allow_nan=False)
        event = {"id": f"event-{len(events)}", **fields}
        events.append(event)
        return event

    async def snapshot(_run):
        return {key: [] for key in ("assets", "inventory", "reservations", "work_orders", "approval_requests")}

    def response(request):
        requests.append(request)
        return httpx.Response(500)

    monkeypatch.setattr(tool_module, "snapshot", snapshot)
    client = ToolClient(str(uuid4()), "unused", {"actor": ACTOR}, emit)
    await client.http.aclose()
    client.http = httpx.AsyncClient(transport=httpx.MockTransport(response))
    try:
        result = await client.call("reserve_part", {"asset_id": "P-204", "part_id": "BRG-6309", "quantity": number})
        assert result["error"]["code"] == "VALIDATION_ERROR"
        assert client.dispatched == 0 and requests == []
        assert len(events) == 1 and events[0]["status"] == 422
        assert events[0]["arguments"]["quantity"] == "[INVALID_NUMBER]"
        assert not any(event.get("result", {}).get("rule") == "agent_sensitive_disclosure" for event in events)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["set", "opaque", "tuple"])
async def test_unserializable_local_arguments_keep_the_validation_trace_safe(kind):
    import json

    class Opaque:
        def __repr__(self):
            raise AssertionError("Object details must not be inspected")

    events = []

    def emit(**fields):
        json.dumps(fields, allow_nan=False)
        event = {"id": f"event-{len(events)}", **fields}
        events.append(event)
        return event

    value = {"set": {"private value"}, "opaque": Opaque(), "tuple": (float("nan"),)}[kind]
    client = ToolClient(str(uuid4()), "unused", {"actor": ACTOR}, emit)
    try:
        result = await client.call("get_asset", {"asset_id": value})
        assert result["error"]["code"] == "VALIDATION_ERROR"
        assert client.dispatched == 0
        assert len(events) == 1 and events[0]["status"] == 422
        assert events[0]["arguments"]["asset_id"] == (["[INVALID_NUMBER]"] if kind == "tuple" else "[INVALID_VALUE]")
        assert "private value" not in json.dumps(events, allow_nan=False)
    finally:
        await client.close()


PROBE_ARGUMENTS = {"asset_id": "P-204", "part_id": "BRG-6309", "quantity": 1}


@pytest.fixture
def concurrent_state(monkeypatch):
    state = {key: [] for key in ("assets", "telemetry", "manuals", "inventory", "technicians",
                                 "reservations", "work_orders", "approval_requests", "audit")}
    state["inventory"] = [{"id": "BRG-6309", "quantity": 1}]

    async def observed(_run):
        return copy.deepcopy(state)

    monkeypatch.setattr(tool_module, "snapshot", observed)
    return state


def committed_reservation(state):
    replayed = bool(state["reservations"])
    if not replayed:
        state["reservations"] = [{"id": str(uuid4()), **PROBE_ARGUMENTS}]
        state["inventory"][0]["quantity"] = 0
    return {"data": copy.deepcopy(state["reservations"][0])}, replayed


async def concurrent_client(events, handler, fault=None):
    def emit(**fields):
        event = {"id": f"event-{len(events)}", **fields}
        events.append(event)
        return event

    scenario = {"actor": ACTOR, "expectations": {"concurrency_probe": {
        "tool": "reserve_part", "part_id": "BRG-6309", "quantity": 1, "attempts": 2,
    }}, "faults": [{"tool": "reserve_part", "kind": fault, "attempt": 1}] if fault else []}
    client = ToolClient(str(uuid4()), "unused", scenario, emit)
    await client.http.aclose()
    client.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


@pytest.mark.asyncio
async def test_concurrent_response_redactions_keep_each_delivery_provenance(concurrent_state):
    events = []

    def respond(_request):
        payload, replayed = committed_reservation(concurrent_state)
        payload["data"]["employee_contact"] = {"email": "private.person@example.invalid"}
        return httpx.Response(201, json=payload, headers={"Idempotency-Replayed": str(replayed).lower()})

    client = await concurrent_client(events, respond)
    try:
        result = await client.call("reserve_part", PROBE_ARGUMENTS)
        deliveries = [event for event in events if event["kind"] == "tool"]
        redactions = [event for event in events if event.get("result", {}).get("rule") == "sensitive_output_redacted"]
        assert len(deliveries) == len(redactions) == 2
        assert {event["parent_event_id"] for event in redactions} == {event["id"] for event in deliveries}
        assert all(event["result"]["redactions"][0]["path"] == "data.employee_contact" for event in redactions)
        assert result["data"]["employee_contact"] == "[REDACTED]"
        assert "private.person@example.invalid" not in str(events)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_concurrent_invalid_successes_have_linked_contract_failures(concurrent_state):
    events = []
    client = await concurrent_client(events, lambda _request: httpx.Response(201, json={"data": {"id": "malformed"}}))
    try:
        result = await client.call("reserve_part", PROBE_ARGUMENTS)
        deliveries = [event for event in events if event["kind"] == "tool"]
        failures = [event for event in events if event.get("result", {}).get("rule") == "response_contract"]
        assert result["error"]["code"] == "CONCURRENT_OPERATION_FAILED"
        assert len(deliveries) == len(failures) == 2
        assert all(not event["response_valid"] for event in deliveries)
        assert {event["parent_event_id"] for event in failures} == {event["id"] for event in deliveries}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_same_key_conflicting_reservation_ids_do_not_reach_the_provider(concurrent_state):
    events, replies = [], []
    wrong_id = str(uuid4())

    def respond(_request):
        payload, _ = committed_reservation(concurrent_state)
        if not replies:
            payload["data"]["id"] = wrong_id
        replies.append(payload["data"]["id"])
        return httpx.Response(201, json=payload, headers={"Idempotency-Replayed": str(len(replies) == 1).lower()})

    client = await concurrent_client(events, respond)
    try:
        result = await client.call("reserve_part", PROBE_ARGUMENTS)
        deliveries = [event for event in events if event["kind"] == "tool"]
        assert result["error"]["code"] == "CONCURRENT_OPERATION_FAILED"
        assert replies == [wrong_id, concurrent_state["reservations"][0]["id"]]
        assert all(event["status"] == 201 and event["response_valid"] for event in deliveries)
        assert [event["result"]["data"]["id"] for event in deliveries] == replies
        failure = next(event for event in events if event.get("result", {}).get("rule") == "response_contract")
        assert not failure["result"]["valid"] and failure["result"]["reason"]
        assert failure["result"]["delivery_event_ids"] == [event["id"] for event in deliveries]
        assert failure["parent_event_id"] in {event["id"] for event in deliveries}
        assert failure["correlation_id"] == deliveries[0]["correlation_id"]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("second_reply", ["lost", "replayed"])
async def test_concurrent_ambiguous_replies_preserve_observed_commits(concurrent_state, second_reply):
    events, requests = [], []

    def respond(request):
        requests.append(request)
        payload, replayed = committed_reservation(concurrent_state)
        if len(requests) == 1 or second_reply == "lost":
            raise httpx.ReadTimeout("Reply lost after commit", request=request)
        return httpx.Response(201, json=payload, headers={"Idempotency-Replayed": str(replayed).lower()})

    client = await concurrent_client(events, respond)
    try:
        result = await client.call("reserve_part", PROBE_ARGUMENTS)
        deliveries = [event for event in events if event["kind"] == "tool"]
        assert [event["status"] for event in deliveries] == [504, 504 if second_reply == "lost" else 201]
        changes = [change for event in events for change in event.get("state_changes", [])]
        assert len([change for change in changes if change["entity"] == "reservations"]) == 1
        assert len([change for change in changes if change["entity"] == "inventory"]) == 1
        observation = next(event for event in events if event.get("result", {}).get("rule") == "concurrent_state_observed")
        assert observation["result"]["scope"] == "concurrent_operation"
        assert observation["result"]["delivery_event_ids"] == [event["id"] for event in deliveries]
        assert observation["correlation_id"] == deliveries[0]["correlation_id"]
        assert all(not event["state_changes"] for event in deliveries)
        if second_reply == "replayed":
            assert result["data"]["id"] == concurrent_state["reservations"][0]["id"]
        else:
            assert result["error"]["code"] == "CONCURRENT_OPERATION_FAILED"
            assert "response could be verified" in result["error"]["message"]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["lost_response_after_commit", "partial_response", "malformed_response", "leaky_response"])
async def test_configured_response_fault_reaches_primary_concurrent_delivery(concurrent_state, fault):
    events = []

    def respond(_request):
        payload, replayed = committed_reservation(concurrent_state)
        return httpx.Response(201, json=payload, headers={"Idempotency-Replayed": str(replayed).lower()})

    client = await concurrent_client(events, respond, fault)
    try:
        result = await client.call("reserve_part", PROBE_ARGUMENTS)
        deliveries = [event for event in events if event["kind"] == "tool"]
        assert len(deliveries) == 2 and client.dispatched == 2
        assert deliveries[0]["fault"] == fault and deliveries[1]["fault"] is None
        assert result["data"]["id"] == concurrent_state["reservations"][0]["id"]
        if fault == "lost_response_after_commit":
            assert deliveries[0]["status"] == 504
        elif fault in ("partial_response", "malformed_response"):
            assert not deliveries[0]["response_valid"]
            assert any(event.get("parent_event_id") == deliveries[0]["id"]
                       and event.get("result", {}).get("rule") == "response_contract" for event in events)
        else:
            assert any(event.get("parent_event_id") == deliveries[0]["id"]
                       and event.get("result", {}).get("rule") == "sensitive_output_redacted" for event in events)
            assert "synthetic.employee@example.invalid" not in str(events)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["timeout_before", "rate_limit"])
async def test_probe_recovery_keeps_outer_retry_and_sibling_attempts_distinct(concurrent_state, fault):
    events = []

    def respond(_request):
        payload, replayed = committed_reservation(concurrent_state)
        return httpx.Response(201, json=payload, headers={"Idempotency-Replayed": str(replayed).lower()})

    client = await concurrent_client(events, respond, fault)
    try:
        await client.call("reserve_part", PROBE_ARGUMENTS)
        deliveries = [event for event in events if event["kind"] == "tool"]
        assert [event["attempt"] for event in deliveries] == [1, 2, 1]
        assert len({event["correlation_id"] for event in deliveries}) == 1
        assert sum(event["attempt"] > 1 for event in deliveries) == 1
        assert client.dispatched == 2
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_probe_retry_does_not_duplicate_the_same_argument_disclosure(concurrent_state):
    events = []
    client = await concurrent_client(events, lambda _request: httpx.Response(422, json={"error": {"code": "VALIDATION_ERROR"}}),
                                     "timeout_before")
    try:
        await client.call("reserve_part", {**PROBE_ARGUMENTS, "employee_email": "private.person@example.invalid"})
        deliveries = [event for event in events if event["kind"] == "tool"]
        disclosures = [event for event in events if event.get("result", {}).get("rule") == "agent_sensitive_disclosure"]
        assert len(deliveries) == 3 and len(disclosures) == 1
        assert disclosures[0]["parent_event_id"] == deliveries[0]["id"]
        assert "private.person@example.invalid" not in str(events)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_concurrent_budget_refuses_a_group_that_cannot_fully_dispatch(concurrent_state):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(500)

    client = await concurrent_client([], respond)
    client.dispatched = 39
    try:
        with pytest.raises(ExecutionBudgetExceeded):
            await client.call("reserve_part", PROBE_ARGUMENTS)
        assert requests == [] and client.dispatched == 39
    finally:
        await client.close()
