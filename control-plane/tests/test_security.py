import json
from pathlib import Path
import subprocess
import sys
import pytest
from lab.security import sanitize, strict_json


def test_nested_secrets_and_free_text_pii_are_redacted_with_provenance():
    redactions = []
    original = {"data": {"employee_contact": {"email": "person@example.invalid"}, "notes": "call person@example.invalid or 310-555-0188; Bearer abc_secret"}, "safe": "P-204"}
    clean = sanitize(original, redactions=redactions)
    assert clean["data"]["employee_contact"] == "[REDACTED]"
    assert "person@example.invalid" not in str(clean)
    assert "310-555-0188" not in str(clean)
    assert "abc_secret" not in str(clean)
    assert clean["safe"] == "P-204"
    assert {item["reason"] for item in redactions} == {"sensitive_field", "sensitive_text"}
    assert original["data"]["employee_contact"]["email"] == "person@example.invalid"


def test_sanitization_is_idempotent():
    first = sanitize({"access_token": "abc", "notes": "x@y.invalid"})
    assert sanitize(first) == first


@pytest.mark.parametrize("private_key", [
    "private.person@example.invalid", "Bearer opaque-fixture-value", "310-555-0188",
])
def test_sensitive_key_text_is_removed_from_payload_and_provenance(private_key):
    redactions = []
    original = {"data": {private_key: {"measurement": 88.6}, "asset_id": "P-204"}}
    clean = sanitize(original, redactions=redactions)
    assert private_key not in json.dumps({"payload": clean, "redactions": redactions})
    assert clean["data"]["asset_id"] == "P-204"
    assert {"measurement": 88.6} in clean["data"].values()
    assert any(item["reason"] == "sensitive_key" and item["path"].startswith("data.[REDACTED")
               for item in redactions)
    assert sanitize(clean) == clean
    assert private_key in original["data"]


def test_sensitive_key_name_still_redacts_value_after_key_text_is_cleaned():
    redactions = []
    clean = sanitize({"contact_person@example.invalid": "not safe to expose"}, redactions=redactions)
    assert list(clean.values()) == ["[REDACTED]"]
    assert {item["reason"] for item in redactions} == {"sensitive_key", "sensitive_field"}
    assert "person@example.invalid" not in json.dumps({"payload": clean, "redactions": redactions})


@pytest.mark.parametrize("key", [
    "APIKey", "clientAPIKey", "APIKeyValue", "APIKEY", "apiKey", "api_key",
    "HTTPAuthorization", "employeeSSN", "SSNValue", "OAuthToken", "HomeAddress",
])
def test_sensitive_field_aliases_handle_acronyms_without_leaking_values(key):
    redactions = []
    assert sanitize({"data": {key: "opaque-private-value"}}, redactions=redactions) == {
        "data": {key: "[REDACTED]"}}
    assert redactions == [{"path": f"data.{key}", "reason": "sensitive_field"}]


def test_acronym_normalization_preserves_technical_fields():
    original = {"assetID": "P-204", "HTTPStatus": 200, "manualRevisionID": "M-204-R7",
                "temperatureC": 88.6, "APIResponseTimeMS": 3, "contactorStatus": "closed"}
    redactions = []
    assert sanitize(original, redactions=redactions) == original
    assert not redactions


@pytest.mark.parametrize("field,length", [("procedure", 30000), ("notes", 20000)])
def test_supported_technical_text_retains_its_safety_instructions(field, length):
    tail = "Supervisor authorization is required before taking the pump offline."
    guidance = "Inspection guidance. " * (length // 21 + 1)
    original = {field: guidance[:length - len(tail)] + tail}
    redactions = []
    assert len(original[field]) == length
    assert sanitize(original, redactions=redactions) == original
    assert not redactions


def test_oversized_text_has_visible_bounded_idempotent_truncation():
    redactions, truncations = [], []
    clean = sanitize({"notes": "x" * 40000}, redactions=redactions, truncations=truncations)
    assert len(clean["notes"]) == 32768
    assert clean["notes"].endswith("[TRUNCATED]")
    assert sanitize(clean) == clean
    assert not redactions
    assert truncations == [{"path": "notes", "reason": "text_limit", "original_length": 40000,
                            "retained_length": 32768}]


def test_truncation_provenance_uses_cleaned_nested_paths_and_is_separate_from_privacy():
    redactions, truncations = [], []
    private_key = "private.person@example.invalid"
    original = {"data": {private_key: [{"procedure": "x" * 40000}], "notes": "y" * 35000}}
    clean = sanitize(original, redactions=redactions, truncations=truncations)
    assert private_key not in json.dumps({"payload": clean, "redactions": redactions, "truncations": truncations})
    assert truncations == [
        {"path": "data.[REDACTED EMAIL][0].procedure", "reason": "text_limit",
         "original_length": 40000, "retained_length": 32768},
        {"path": "data.notes", "reason": "text_limit", "original_length": 35000, "retained_length": 32768},
    ]
    assert redactions == [{"path": "data.[REDACTED EMAIL]", "reason": "sensitive_key"}]
    repeated_truncations = []
    assert sanitize(clean, truncations=repeated_truncations) == clean
    assert not repeated_truncations


@pytest.mark.parametrize("field,length", [("procedure", 30000), ("notes", 20000)])
def test_allowed_technical_text_can_expand_during_privacy_redaction_without_losing_content(field, length):
    email = "a@b.io"
    prefix = ("Inspection guidance. " * (length // 21 + 1))[:length - len(email) - 1]
    original = {field: prefix + " " + email}
    redactions, truncations = [], []
    clean = sanitize(original, redactions=redactions, truncations=truncations)
    assert len(original[field]) == length
    assert clean[field] == prefix + " [REDACTED EMAIL]"
    assert len(clean[field]) > length
    assert redactions == [{"path": field, "reason": "sensitive_text"}]
    assert not truncations


def test_long_unbroken_text_cannot_stall_sanitization():
    # A child process keeps a pathological match from stalling the test suite.
    script = "\n".join([
        "import sys",
        f"sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})",
        "from lab.security import sanitize",
        "clean = sanitize('x' * 200000)",
        "assert len(clean) == 32768 and clean.endswith('[TRUNCATED]')",
        "key = 'X' * 200000",
        "assert sanitize({key: 'ordinary'}) == {key: 'ordinary'}",
    ])
    subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, timeout=5)


def test_email_redaction_keeps_complete_local_parts_and_surrounding_text():
    assert sanitize("Owner (plant.maintenance+night@example.invalid); backup a@b.invalid.") == (
        "Owner ([REDACTED EMAIL]); backup [REDACTED EMAIL].")


def test_invalid_unicode_is_readable_in_trace_keys_and_values_without_false_disclosure():
    redactions = []
    clean = sanitize({"asset_id": "P-204\x00", "note\ud800": "bad\udfff"}, redactions=redactions)
    assert clean == {"asset_id": "P-204[NUL]", "note[INVALID_UNICODE]": "bad[INVALID_UNICODE]"}
    assert not redactions
    assert sanitize(clean) == clean


def test_normal_unicode_and_measurement_symbols_remain_intact():
    original = {"notes": "Temperature 88.6\u00b0C; inspection \U0001f527\nSecond shift"}
    assert sanitize(original) == original


def test_nonfinite_numbers_are_json_safe_without_false_sensitive_disclosure():
    redactions = []
    clean = sanitize({"values": [float("nan"), float("inf"), float("-inf"), 0.0, 1.25]}, redactions=redactions)
    assert clean == {"values": ["[INVALID_NUMBER]"] * 3 + [0.0, 1.25]}
    assert not redactions
    assert json.loads(json.dumps(clean, allow_nan=False)) == clean


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"])
def test_json_numbers_must_be_finite_even_in_nested_unused_fields(number):
    with pytest.raises(ValueError, match="finite"):
        strict_json('{"extra": [{"measurement": ' + number + '}]}')


def test_strict_json_preserves_valid_numeric_values_and_quoted_words():
    assert strict_json('{"note":"NaN is an invalid reading","small":1e-6,"count":2,"flag":true}') == {
        "note": "NaN is an invalid reading", "small": 1e-6, "count": 2, "flag": True}


def test_unsupported_objects_and_keys_use_fixed_markers_without_inspection():
    class Opaque:
        def __repr__(self):
            raise AssertionError("Object details must not be inspected")

    redactions = []
    clean = sanitize({"set": {"private value"}, "object": Opaque(), "mapping": {Opaque(): "ordinary"}}, redactions=redactions)
    assert clean == {"set": "[INVALID_VALUE]", "object": "[INVALID_VALUE]", "mapping": {"[INVALID_KEY]": "ordinary"}}
    assert not redactions
    assert json.loads(json.dumps(clean, allow_nan=False)) == clean


def test_tuple_values_are_sanitized_as_json_arrays():
    redactions = []
    clean = sanitize({"values": (1.25, float("inf"), {"nested": (float("nan"),)})}, redactions=redactions)
    assert clean == {"values": [1.25, "[INVALID_NUMBER]", {"nested": ["[INVALID_NUMBER]"]}]}
    assert not redactions
    assert json.loads(json.dumps(clean, allow_nan=False)) == clean
