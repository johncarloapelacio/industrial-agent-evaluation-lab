import json
import math
import re
from datetime import datetime
from .config import SCENARIO_DIR
from .domain import number, select_evidence


TOOLS = {"get_asset", "query_telemetry", "get_manual_revision", "search_inventory", "list_technicians",
         "reserve_part", "create_work_order", "request_supervisor_approval", "set_asset_status"}
GROUPS = {"final_state", "authorization_safety", "tool_use", "evidence_freshness", "recovery_efficiency"}
FAULTS = {"timeout_before", "lost_response_after_commit", "rate_limit", "partial_response", "malformed_response", "leaky_response"}
DECISIONS = {"maintenance_required", "insufficient_evidence", "access_denied", "monitor"}
STATUSES = {"running", "offline", "degraded", "standby"}


def validate(scenario, source="scenario"):
    """Fail before seeding when the trusted ground truth is internally invalid."""
    def require(condition, message):
        if not condition:
            raise ValueError(f"Invalid scenario {source}: {message}")

    def database_text(value, maximum):
        return (isinstance(value, str) and len(value) <= maximum
                and not any(character == "\x00" or 0xD800 <= ord(character) <= 0xDFFF for character in value))

    def text(value):
        return isinstance(value, str) and database_text(value, len(value)) and bool(value.strip())

    def identifier(value):
        return database_text(value, 128) and bool(value) and value == value.strip()

    def integer(value, minimum=0, maximum=10000):
        return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum

    def member(value, collection):
        return isinstance(value, str) and value in collection

    def timestamp(value):
        pattern = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)"
        if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
            return False
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
        except ValueError:
            return False

    def string_list(value):
        return isinstance(value, list) and all(text(item) for item in value) and len(set(value)) == len(value)

    required = {"id", "name", "category", "description", "request", "actor", "asset_id", "clock", "seed", "expectations", "rubric", "golden_tools", "faults"}
    require(isinstance(scenario, dict) and required <= scenario.keys(), "required specification fields are missing")
    require(text(scenario["id"]) and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", scenario["id"]) is not None, "id must be a URL-safe slug")
    require(all(text(scenario[key]) for key in ("name", "description", "request", "asset_id")), "name, description, request and target must be nonempty")
    require(identifier(scenario["asset_id"]), "target identifier must be canonical")
    require(scenario["category"] in ("normal", "reliability", "security"), "unknown category")
    require(timestamp(scenario["clock"]), "clock must include a valid timezone and at most six fractional digits")
    actor = scenario["actor"]
    require(isinstance(actor, dict) and all(identifier(actor.get(key)) for key in ("id", "facility_id", "tenant_id")), "actor identity and scope must use canonical identifiers")
    require(actor.get("role") in ("viewer", "technician", "supervisor"), "unknown actor role")
    seed = scenario["seed"]
    require(isinstance(seed, dict), "seed must be an object")
    indexed = {}
    limits = {"assets": 1000, "telemetry": 10000, "manuals": 1000, "inventory": 1000, "technicians": 1000}
    for entity in limits:
        rows = seed.get(entity)
        require(isinstance(rows, list) and len(rows) <= limits[entity]
                and all(isinstance(row, dict) and identifier(row.get("id")) for row in rows), f"{entity} must contain bounded records with canonical identifiers")
        indexed[entity] = {row["id"]: row for row in rows}
        require(len(indexed[entity]) == len(rows), f"{entity} has duplicate identifiers")
    target = indexed["assets"].get(scenario["asset_id"])
    require(target is not None, "target asset is absent from the seed")
    for entity in ("assets", "inventory", "technicians"):
        require(all(identifier(row.get("facility_id")) and identifier(row.get("tenant_id")) for row in seed[entity]), f"{entity} scope must use canonical identifiers")
        require(all(database_text(row.get("name"), 500) and bool(row["name"].strip()) for row in seed[entity]), f"{entity} names are required and bounded")
    require(all(member(row.get("status"), STATUSES) for row in seed["assets"]), "unknown asset status")
    require(all(database_text(row.get("notes", ""), 20000) for row in seed["assets"]), "asset notes are invalid or too long")
    for entity, field in (("telemetry", "observed_at"), ("manuals", "effective_at")):
        require(all(member(row.get("asset_id"), indexed["assets"]) and timestamp(row.get(field)) for row in seed[entity]), f"{entity} has an unknown asset or invalid timestamp")
    require(all(integer(row.get("quantity")) for row in seed["inventory"]), "inventory quantities must be nonnegative integers")
    for row in seed["manuals"]:
        require(isinstance(row.get("approved"), bool) and number(row.get("temperature_limit_c")) and number(row.get("vibration_limit_mm_s")), "manual approval and limits are invalid")
        require(row.get("required_part_id") is None or member(row["required_part_id"], indexed["inventory"]), "manual references an unknown part")
        require(identifier(row.get("revision")) and database_text(row.get("procedure"), 30000) and bool(row["procedure"].strip()), "manual revision and procedure are required and bounded")
    require(all(number(row.get("temperature")) and number(row.get("vibration")) for row in seed["telemetry"]), "telemetry values must be finite numbers")
    require(all(all(identifier(row.get(key)) for key in ("temperature_unit", "vibration_unit", "sensor_status")) for row in seed["telemetry"]), "telemetry units and sensor status must be identifiers")
    for row in seed["technicians"]:
        require(isinstance(row.get("available"), bool) and string_list(row.get("certifications")) and len(row["certifications"]) <= 100
                and all(identifier(item) for item in row["certifications"]), "technician availability and certifications are invalid")

    expected = scenario["expectations"]
    require(isinstance(expected, dict), "expectations must be an object")
    require(member(expected.get("decision"), DECISIONS), "unknown expected decision")
    require(all(integer(expected.get(key)) for key in ("work_orders", "reservations", "approval_requests")), "expected counts must be nonnegative integers")
    require(member(expected.get("asset_status", target["status"]), STATUSES), "unknown expected asset status")
    require(integer(expected.get("max_calls"), 1, 40), "max_calls must be between 1 and 40")
    require(string_list(expected.get("required_evidence")) and all(identifier(item) for item in expected["required_evidence"]), "required_evidence must contain unique canonical identifiers")
    for field in ("required_tools", "forbidden_tools"):
        require(string_list(expected.get(field)) and set(expected[field]) <= TOOLS, f"{field} contains unknown or duplicate tools")
    require(not set(expected["required_tools"]) & set(expected["forbidden_tools"]), "required and forbidden tools overlap")
    evidence = {**indexed["telemetry"], **indexed["manuals"]}
    require(len(evidence) == len(indexed["telemetry"]) + len(indexed["manuals"]), "telemetry and manuals must use distinct evidence identifiers")
    require(all(item in evidence and evidence[item]["asset_id"] == scenario["asset_id"] for item in expected["required_evidence"]), "required evidence must belong to the target asset")
    scoped = all(target[key] == actor[key] for key in ("facility_id", "tenant_id"))
    require(scoped != (expected["decision"] == "access_denied"), "expected access decision disagrees with the actor scope")
    if expected["decision"] == "access_denied":
        require(not expected["required_evidence"] and not any(expected[key] for key in ("work_orders", "reservations", "approval_requests")), "access-denied cases cannot require inaccessible evidence or mutations")
    if expected["decision"] in ("monitor", "maintenance_required"):
        reading, manual = select_evidence([row for row in seed["telemetry"] if row["asset_id"] == scenario["asset_id"]],
                                         [row for row in seed["manuals"] if row["asset_id"] == scenario["asset_id"]], scenario["clock"])
        require(reading is not None and manual is not None, "expected decision requires current valid telemetry and an effective approved manual")
        exceeds = reading["temperature_c"] > manual["temperature_limit_c"] or reading["vibration_mm_s"] > manual["vibration_limit_mm_s"]
        require(exceeds == (expected["decision"] == "maintenance_required"), "expected decision contradicts the current approved limits")
    if "work_order_priority" in expected:
        require(expected["work_order_priority"] in ("normal", "urgent") and expected["work_orders"] > 0, "invalid work order priority expectation")
    if "technician_id" in expected:
        require(text(expected["technician_id"]), "expected technician must be an identifier")
        technician = indexed["technicians"].get(expected["technician_id"])
        require(technician is not None and expected["work_orders"] > 0, "expected technician must exist for a work order")
        require(all(technician[key] == actor[key] for key in ("facility_id", "tenant_id")) and technician["available"] and "rotating-equipment" in technician["certifications"], "expected technician must be in scope, available and certified")
    require(actor["role"] != "viewer" or not any(expected[key] for key in ("work_orders", "reservations", "approval_requests")), "viewer cannot be expected to perform mutations")

    rubric = scenario["rubric"]
    require(isinstance(rubric, list) and len(rubric) == len(GROUPS) and all(isinstance(item, dict) for item in rubric), "rubric must declare five scoring groups")
    require(all(text(item.get("id")) for item in rubric) and {item["id"] for item in rubric} == GROUPS, "rubric groups must be known and unique")
    require(all(number(item.get("weight")) and item["weight"] > 0 for item in rubric), "rubric weights must be positive finite numbers")
    require(math.isclose(sum(item["weight"] for item in rubric), 100, abs_tol=1e-9), "rubric weights must sum to 100")
    require(isinstance(scenario["golden_tools"], list) and all(isinstance(item, str) and item in TOOLS for item in scenario["golden_tools"]), "golden_tools contains an unknown tool")
    require(isinstance(scenario["faults"], list), "faults must be a list")
    seen = set()
    for fault in scenario["faults"]:
        require(isinstance(fault, dict) and set(fault) == {"tool", "kind", "attempt"}, "fault fields are invalid")
        require(isinstance(fault["tool"], str) and fault["tool"] in TOOLS and isinstance(fault["kind"], str) and fault["kind"] in FAULTS and integer(fault["attempt"], 1, 40), "fault tool, kind or attempt is invalid")
        key = (fault["tool"], fault["attempt"])
        require(key not in seen, "faults collide on the same tool attempt")
        seen.add(key)
    if "concurrency_probe" in expected:
        probe = expected["concurrency_probe"]
        require(isinstance(probe, dict) and probe.get("tool") == "reserve_part", "concurrency probe must target reserve_part")
        require(member(probe.get("part_id"), indexed["inventory"]) and integer(probe.get("quantity"), 1), "concurrency probe part or quantity is invalid")
        require(integer(probe.get("attempts"), 2, 4) and integer(probe.get("successful_reservations"), 1, probe["attempts"]), "concurrency probe attempt/outcome counts are invalid")
        require(isinstance(probe.get("same_idempotency_key", True), bool), "concurrency key mode must be boolean")
    return scenario


def load_all():
    scenarios = []
    for path in sorted(SCENARIO_DIR.glob("*.json")):
        scenario = json.loads(path.read_text(encoding="utf-8-sig"))
        scenarios.append(validate(scenario, path.name))
    if len({s["id"] for s in scenarios}) != len(scenarios):
        raise ValueError("Duplicate scenario IDs")
    return scenarios


def find(scenario_id):
    return next((s for s in load_all() if s["id"] == scenario_id), None)


def public(scenario):
    return {key: scenario.get(key) for key in
            ("id", "name", "category", "description", "request", "actor", "asset_id")}
