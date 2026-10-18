import asyncio
import copy
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4, uuid5
from . import storage
from .domain import complete_snapshot, instant, number
from .evaluator import evaluate
from .providers import baseline, compatible
from .security import sanitize
from .tools import ExecutionBudgetExceeded, ToolClient, seed_scope, snapshot, state_diff


async def execute(scenario, provider="baseline", replay_of=None):
    run_id = str(uuid4())
    started = time.perf_counter()
    detail = {"id": run_id, "scenario_id": scenario["id"], "scenario_name": scenario["name"],
        "category": scenario["category"], "status": "running", "provider": provider, "score": None, "passed": None,
        "created_at": datetime.now(timezone.utc).isoformat(), "tool_calls": 0, "retries": 0, "duration_ms": 0,
        "request": scenario["request"], "actor": scenario["actor"], "asset_id": scenario["asset_id"], "clock": scenario["clock"],
        "events": [], "initial_state": {}, "final_state": {}, "state_diff": [], "report": None,
        "final_response": {}, "golden_tools": scenario.get("golden_tools", []), "completion_reason": None,
        "replay_of": replay_of, "scenario_hash": hashlib.sha256(json.dumps(scenario, sort_keys=True).encode()).hexdigest(),
        "_scenario": copy.deepcopy(scenario)}
    storage.save(detail)

    def emit(**fields):
        index = len(detail["events"]) + 1
        previous = detail["events"][-1]["id"] if detail["events"] else None
        finished_at = datetime.now(timezone.utc)
        latency = fields.get("latency_ms", 0)
        latency = max(latency, 0) if number(latency) else 0
        event = {"id": str(uuid5(UUID(run_id), f"event:{index}")), "parent_event_id": previous,
            "correlation_id": run_id, "step": index, "kind": "decision", "state": "plan", "arguments": {},
            "result": {}, "attempt": 1, "latency_ms": 0, "state_changes": [],
            **fields,
            "started_at": (finished_at - timedelta(milliseconds=latency)).isoformat(),
            "finished_at": finished_at.isoformat(),
            "scenario_time": ((instant(scenario["clock"]) or finished_at) + timedelta(seconds=index)).isoformat()}
        event = sanitize(event)
        detail["events"].append(event)
        detail["tool_calls"] = sum(event["kind"] == "tool" for event in detail["events"])
        storage.save(detail)
        return event

    client = None
    try:
        token = await seed_scope(run_id, scenario)
        detail["initial_state"] = await snapshot(run_id)
        client = ToolClient(run_id, token, scenario, emit)
        context = {"request": scenario["request"], "actor": scenario["actor"], "asset_id": scenario["asset_id"], "clock": scenario["clock"]}
        if provider in ("baseline", "careless"):
            answer = await asyncio.wait_for(baseline(context, client, emit, careless=provider == "careless"), timeout=180)
        else:
            answer = await asyncio.wait_for(compatible(context, client, emit), timeout=180)
        redactions = []
        detail["final_response"] = sanitize(answer, redactions=redactions)
        if redactions:
            emit(kind="validation", state="validate_result", result={"rule": "agent_sensitive_disclosure", "redactions": redactions})
        detail["completion_reason"] = "finished"
    except Exception as exc:
        # Do not persist request headers, URLs containing credentials, or arbitrary exception messages.
        emit(kind="validation", state="validate_result", result={"rule": "execution_error", "error_type": type(exc).__name__})
        detail["final_response"] = {"decision": "insufficient_evidence", "summary": "Execution stopped before a verified workflow could finish. Inspect the trace for the failing boundary.",
                                    "evidence_ids": [], "recommended_action": "Resolve the recorded execution error and replay in a fresh scope."}
        detail["completion_reason"] = "budget_exhausted" if isinstance(exc, (TimeoutError, ExecutionBudgetExceeded)) else "execution_error"
    finally:
        if client:
            try:
                await client.close()
            except Exception:
                emit(kind="validation", state="validate_result", result={"rule": "tool_client_cleanup_failed"})
            try:
                detail["final_state"] = await snapshot(run_id)
            except Exception:
                detail["final_state"] = {}
                if detail["completion_reason"] == "finished":
                    detail["completion_reason"] = "execution_error"
                emit(kind="validation", state="validate_result", result={"rule": "final_state_unavailable"})
    detail["state_diff"] = state_diff(detail["initial_state"], detail["final_state"])
    emit(kind="completion", state="evaluate", result={"completion_reason": detail["completion_reason"], "decision": detail["final_response"].get("decision")})
    detail["report"] = evaluate(scenario, detail["initial_state"], detail["final_state"], detail["events"], detail["final_response"], detail["completion_reason"])
    detail["score"], detail["passed"] = detail["report"]["score"], detail["report"]["passed"]
    detail["tool_calls"], detail["retries"] = detail["report"]["metrics"]["tool_calls"], detail["report"]["metrics"]["retries"]
    detail["duration_ms"] = round((time.perf_counter() - started) * 1000, 2)
    detail["status"] = "completed" if detail["completion_reason"] == "finished" else "failed"
    storage.save(detail)
    return public_detail(detail)


def public_detail(detail):
    return {key: value for key, value in detail.items() if not key.startswith("_")}


async def recover_interrupted():
    """Close unfinished runs after restart without repeating any actions.

    One control-plane worker owns run execution in this local deployment. A record
    still marked running at its next startup belongs to the previous process.
    """
    recovered = []
    for previous in storage.list_incomplete():
        detail = copy.deepcopy(previous)
        scenario = detail["_scenario"]
        run_id = detail["id"]
        recovered_at = datetime.now(timezone.utc).isoformat()

        def append(**fields):
            events = detail.setdefault("events", [])
            index = len(events) + 1
            emitted_at = datetime.now(timezone.utc)
            event = {"id": str(uuid5(UUID(run_id), f"event:{index}")),
                "parent_event_id": events[-1]["id"] if events else None,
                "correlation_id": run_id, "step": index, "kind": "validation", "state": "validate_result",
                "arguments": {}, "result": {}, "attempt": 1, "latency_ms": 0,
                "state_changes": [], **fields,
                "started_at": emitted_at.isoformat(), "finished_at": emitted_at.isoformat(),
                "scenario_time": ((instant(scenario["clock"]) or emitted_at) + timedelta(seconds=index)).isoformat()}
            events.append(sanitize(event))

        if not complete_snapshot(detail.get("initial_state")):
            append(result={"rule": "state_observation_unavailable", "phase": "initial", "provenance": "startup_recovery"})
        state_available = False
        try:
            detail["final_state"] = await snapshot(run_id)
            if not complete_snapshot(detail["final_state"]):
                raise ValueError("Recovery snapshot does not match the internal state contract")
            state_available = True
        except Exception:
            # A prior snapshot cannot stand in for the state at recovery time.
            detail["final_state"] = {}
            append(result={"rule": "final_state_unavailable", "provenance": "startup_recovery"})
        detail["recovery"] = {"recovered_at": recovered_at, "reason": "process_interrupted",
                              "final_state_available": state_available, "duration_incomplete": True}
        if not detail.get("final_response"):
            detail["final_response"] = {"decision": "insufficient_evidence",
                "summary": "The control process stopped before a completed result was recorded. The preserved trace and recovery snapshot show the observed workflow state.",
                "evidence_ids": [], "recommended_action": "Review committed changes, then replay in a fresh isolated scope if another attempt is needed."}
        detail["completion_reason"] = "process_interrupted"
        detail["state_diff"] = state_diff(detail.get("initial_state", {}), detail["final_state"])
        append(kind="completion", state="evaluate", result={"completion_reason": "process_interrupted",
            "decision": detail["final_response"].get("decision"), "provenance": "startup_recovery",
            "observation": "A persisted running record was found after control-plane process startup.",
            "final_state_available": state_available})
        detail["report"] = evaluate(scenario, detail.get("initial_state", {}), detail["final_state"],
            detail["events"], detail["final_response"], detail["completion_reason"])
        detail["score"], detail["passed"] = detail["report"]["score"], detail["report"]["passed"]
        detail["tool_calls"], detail["retries"] = detail["report"]["metrics"]["tool_calls"], detail["report"]["metrics"]["retries"]
        detail["status"] = "failed"
        storage.save(detail)
        recovered.append(public_detail(detail))
    return recovered
