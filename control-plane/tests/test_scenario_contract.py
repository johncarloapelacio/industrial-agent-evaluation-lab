import copy

import pytest

from lab import scenarios


@pytest.mark.parametrize("field", ["id", "tenant_id", "facility_id"])
def test_trusted_actor_identifiers_cannot_change_when_the_api_trims_them(field):
    spec = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    spec["actor"][field] = " " + spec["actor"][field] + " "
    with pytest.raises(ValueError, match="canonical identifiers"):
        scenarios.validate(spec)


@pytest.mark.parametrize("entity,field", [("assets", "name"), ("inventory", "name"), ("technicians", "name"),
                                         ("manuals", "revision"), ("manuals", "procedure"),
                                         ("telemetry", "temperature_unit"), ("telemetry", "sensor_status")])
def test_required_operational_seed_fields_fail_before_scope_creation(entity, field):
    spec = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    del spec["seed"][entity][0][field]
    with pytest.raises(ValueError, match="Invalid scenario"):
        scenarios.validate(spec)


@pytest.mark.parametrize("value", [" P-204", "P-204 ", "P-204\x00", "x" * 129, "bad\ud800"])
def test_trusted_resource_identifiers_match_the_operational_contract(value):
    spec = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    spec["seed"]["assets"][0]["id"] = value
    with pytest.raises(ValueError, match="canonical identifiers"):
        scenarios.validate(spec)


def test_telemetry_and_manual_citations_cannot_share_an_ambiguous_identifier():
    spec = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    spec["seed"]["manuals"][0]["id"] = spec["seed"]["telemetry"][0]["id"]
    with pytest.raises(ValueError, match="distinct evidence identifiers"):
        scenarios.validate(spec)


@pytest.mark.parametrize("scenario_id,temperature,vibration", [
    ("conflicting-observation-times", 90, 3.1),
    ("overheating-stale-sensor", 70, 3.1),
])
def test_reference_decision_cannot_contradict_current_normalized_measurements(scenario_id, temperature, vibration):
    spec = copy.deepcopy(scenarios.find(scenario_id))
    reading = next(row for row in spec["seed"]["telemetry"] if row["id"] == spec["expectations"]["required_evidence"][0])
    reading.update(temperature=temperature, vibration=vibration)
    with pytest.raises(ValueError, match="contradicts the current approved limits"):
        scenarios.validate(spec)


def test_workflow_counts_remain_declared_by_the_scenario():
    spec = copy.deepcopy(scenarios.find("conflicting-observation-times"))
    spec["expectations"]["work_orders"] = 1
    assert scenarios.validate(spec) is spec


def test_failure_scenario_can_deliberately_lack_current_usable_evidence():
    spec = copy.deepcopy(scenarios.find("conflicting-observation-times"))
    spec["expectations"]["decision"] = "insufficient_evidence"
    spec["expectations"]["required_evidence"] = []
    for reading in spec["seed"]["telemetry"]:
        if reading["asset_id"] == spec["asset_id"]:
            reading["temperature_unit"] = "unsupported-unit"
    assert scenarios.validate(spec) is spec


def test_validation_preserves_the_saved_specification_and_valid_alternative_tool_order():
    for spec in scenarios.load_all():
        expected = copy.deepcopy(spec)
        spec["golden_tools"] = list(reversed(spec["golden_tools"]))
        expected["golden_tools"] = list(spec["golden_tools"])
        assert scenarios.validate(spec) == expected


@pytest.mark.parametrize("clock", ["2026-10-17 14:00:00+00:00", "20261017T140000Z", "2026-10-17T14:00:00+00:00:01"])
def test_timestamps_accepted_only_by_python_cannot_reach_operational_seeding(clock):
    spec = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    spec["clock"] = clock
    with pytest.raises(ValueError, match="clock must include a valid timezone"):
        scenarios.validate(spec)


@pytest.mark.parametrize("clock", ["2026-10-17T16:00:00+02:00", "2026-10-17T14:00:00.000000Z"])
def test_operational_timestamp_offsets_and_fractional_seconds_remain_supported(clock):
    spec = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    spec["clock"] = clock
    assert scenarios.validate(spec)["clock"] == clock


@pytest.mark.parametrize("location", ["clock", "telemetry", "manuals"])
def test_timestamp_precision_cannot_change_when_postgresql_stores_the_seed(location):
    spec = copy.deepcopy(scenarios.find("overheating-stale-sensor"))
    value = "2026-10-17T14:00:00.0000004Z"
    if location == "clock":
        spec["clock"] = value
    else:
        field = "observed_at" if location == "telemetry" else "effective_at"
        spec["seed"][location][0][field] = value
    with pytest.raises(ValueError, match="Invalid scenario"):
        scenarios.validate(spec)
