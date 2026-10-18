from contextlib import asynccontextmanager
import asyncio
import hmac
import os
from typing import Literal
from uuid import UUID
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from . import storage, scenarios
from .config import REVIEW_KEY, TOOL_API_URL
from .evaluator import evaluate
from .runner import execute, public_detail, recover_interrupted
from .security import sanitize


@asynccontextmanager
async def lifespan(app):
    storage.initialize()
    if len(scenarios.load_all()) < 12:
        raise RuntimeError("At least twelve scenario specifications are required")
    await recover_interrupted()
    if os.getenv("LAB_SEED_DEMO", "0") == "1" and not storage.list_runs():
        for scenario_id, provider in (("lost-work-order-response", "baseline"), ("overheating-stale-sensor", "careless"), ("overheating-stale-sensor", "baseline")):
            await execute(scenarios.find(scenario_id), provider)
    yield


app = FastAPI(title="Industrial Agent Evaluation Lab", version="1.0.0", lifespan=lifespan)
run_gate = asyncio.Semaphore(4)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exc):
    # Validation errors can echo values that are unsafe to encode or share.
    return JSONResponse({"detail": sanitize(exc.errors())}, status_code=422)


def reviewer(authorization: str = Header(default="")):
    if not hmac.compare_digest(authorization.encode("utf-8"), f"Bearer {REVIEW_KEY}".encode("utf-8")):
        raise HTTPException(401, "A valid reviewer bearer token is required")


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_id: str
    provider: Literal["baseline", "careless", "openai-compatible"] = "baseline"


def require_run(run_id):
    try:
        canonical_id = str(UUID(run_id))
    except ValueError:
        raise HTTPException(404, "Run not found") from None
    detail = storage.get(canonical_id)
    if not detail:
        raise HTTPException(404, "Run not found")
    return detail


@app.get("/api/health")
async def health():
    try:
        with storage.connect() as db:
            db.execute("SELECT 1")
        async with httpx.AsyncClient(timeout=3) as client:
            upstream = await client.get(f"{TOOL_API_URL}/health")
            upstream.raise_for_status()
        return {"status": "healthy", "database": "connected", "tool_api": "connected"}
    except Exception:
        return JSONResponse({"status": "unhealthy"}, status_code=503)


@app.get("/api/scenarios")
def scenario_list():
    return [scenarios.public(item) for item in scenarios.load_all()]


@app.get("/api/runs")
def run_list():
    return storage.list_runs()


@app.post("/api/runs", dependencies=[Depends(reviewer)])
async def create_run(body: RunRequest):
    scenario = scenarios.find(body.scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    async with run_gate:
        return await execute(scenario, body.provider)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    return public_detail(require_run(run_id))


@app.post("/api/runs/{run_id}/replay", dependencies=[Depends(reviewer)])
async def replay_run(run_id: str):
    previous = require_run(run_id)
    async with run_gate:
        return await execute(previous["_scenario"], previous["provider"], replay_of=previous["id"])


@app.post("/api/runs/{run_id}/evaluate", dependencies=[Depends(reviewer)])
def reevaluate_run(run_id: str, response: Response):
    previous = require_run(run_id)
    if previous["status"] == "running":
        raise HTTPException(409, "Run has not completed")
    report = evaluate(previous["_scenario"], previous["initial_state"], previous["final_state"],
                      previous["events"], previous["final_response"], previous["completion_reason"])
    response.headers["X-Evaluator-Version"] = report["evaluator_version"]
    response.headers["X-Original-Evaluator-Version"] = (previous.get("report") or {}).get("evaluator_version", "legacy-unversioned")
    return report


@app.get("/api/runs/{run_id}/export")
def export_run(run_id: str):
    detail = public_detail(require_run(run_id))
    return JSONResponse(detail, headers={"Content-Disposition": f'attachment; filename="run-{detail["id"]}.json"'})


@app.get("/api/runs/{run_id}/compare/{other_id}")
def compare_runs(run_id: str, other_id: str):
    left, right = public_detail(require_run(run_id)), public_detail(require_run(other_id))
    left_report, right_report = left.get("report") or {}, right.get("report") or {}
    right_criteria = {item["id"]: item for item in right_report.get("criteria", [])}
    return {"left": left, "right": right, "score_delta": (right.get("score") or 0) - (left.get("score") or 0),
        "tool_call_delta": right["tool_calls"] - left["tool_calls"],
        "criteria": [{"id": item["id"], "left_passed": item["passed"], "right_passed": right_criteria.get(item["id"], {}).get("passed")}
                     for item in left_report.get("criteria", [])],
        "comparable": (left["scenario_hash"] == right["scenario_hash"] and bool(left_report.get("evaluator_version")) and
                       left_report.get("evaluator_version") == right_report.get("evaluator_version")),
        "note": "Different scenario snapshots or evaluator versions are descriptive comparisons, not controlled provider comparisons."}
