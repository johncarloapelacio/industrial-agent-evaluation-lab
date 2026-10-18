from lab.domain import normalize_reading, select_evidence


def reading(**changes):
    return {"id": "T-current", "asset_id": "P-204", "observed_at": "2026-10-17T14:50:00Z", "temperature": 194,
            "temperature_unit": "F", "vibration": 0.2, "vibration_unit": "in/s", "sensor_status": "valid", **changes}


def manual(**changes):
    return {"id": "M-current", "approved": True, "effective_at": "2026-10-16T00:00:00Z", **changes}


def test_normalizes_both_independent_units():
    normalized = normalize_reading(reading())
    assert normalized["temperature_c"] == 90
    assert abs(normalized["vibration_mm_s"] - 5.08) < 1e-10


def test_rejects_unknown_units_nonfinite_and_boolean_measurements():
    for changes in ({"temperature_unit": "psi"}, {"vibration_unit": "unknown"}, {"temperature": float("nan")}, {"vibration": True}):
        assert normalize_reading(reading(**changes)) is None


def test_current_valid_evidence_wins_over_old_future_and_faulty_samples():
    readings = [reading(id="old", observed_at="2026-10-16T14:59:00Z"), reading(id="future", observed_at="2026-10-17T15:10:00Z"),
                reading(id="faulty", observed_at="2026-10-17T14:59:00Z", sensor_status="stale"), reading()]
    manuals = [manual(id="draft", effective_at="2026-10-17T00:00:00Z", approved=False),
               manual(id="future", effective_at="2027-01-01T00:00:00Z"), manual(), manual(id="old", effective_at="2025-01-01T00:00:00Z")]
    chosen_reading, chosen_manual = select_evidence(readings, manuals, "2026-10-17T15:00:00Z")
    assert chosen_reading["id"] == "T-current"
    assert chosen_manual["id"] == "M-current"


def test_no_evidence_is_a_supported_result():
    assert select_evidence([], [], "2026-10-17T15:00:00Z") == (None, None)
    assert select_evidence([reading(observed_at="bad")], [manual(effective_at="bad")], "2026-10-17T15:00:00Z") == (None, None)
