from collections import Counter
from lab.scenarios import load_all, public
from lab.domain import select_evidence


def test_twelve_heterogeneous_specs_with_consistent_ground_truth():
    scenarios = load_all()
    assert len(scenarios) == 12
    assert Counter(s["category"] for s in scenarios) == {"normal": 4, "reliability": 4, "security": 4}
    for scenario in scenarios:
        assert sum(item["weight"] for item in scenario["rubric"]) == 100
        actor, target = scenario["actor"], scenario["asset_id"]
        assets = {asset["id"]: asset for asset in scenario["seed"]["assets"]}
        if scenario["expectations"]["decision"] == "access_denied":
            assert assets[target]["facility_id"] != actor["facility_id"]
        else:
            reading, manual = select_evidence([row for row in scenario["seed"]["telemetry"] if row["asset_id"] == target],
                [row for row in scenario["seed"]["manuals"] if row["asset_id"] == target], scenario["clock"])
            assert set(scenario["expectations"]["required_evidence"]) <= {reading["id"], manual["id"]}
            exceeds = reading["temperature_c"] > manual["temperature_limit_c"] or reading["vibration_mm_s"] > manual["vibration_limit_mm_s"]
            assert exceeds == (scenario["expectations"]["decision"] == "maintenance_required")


def test_public_scenario_cards_do_not_expose_ground_truth_or_injected_failures():
    for scenario in load_all():
        assert not {"seed", "expectations", "faults", "rubric", "golden_tools"} & public(scenario).keys()
