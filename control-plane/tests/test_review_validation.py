"""Malformed reviewer requests should fail without starting an evaluation."""
import json

import pytest
from fastapi.testclient import TestClient

from lab import app as api


@pytest.mark.parametrize("body", [
    '{"scenario_id":NaN}',
    '{"scenario_id":1e999}',
    '{"scenario_id":"missing","provider":Infinity}',
    '{"scenario_id":"missing","extra":{"nested":[-Infinity]}}',
    '{"scenario_id":"missing","provider":"\\ud800"}',
    '{"scenario_id":"missing","extra\\udfff":"value"}',
    '[NaN]',
    '{"scenario_id":',
])
def test_invalid_requests_return_readable_json_without_execution(monkeypatch, body):
    async def unexpected_execution(*args, **kwargs):
        pytest.fail("An invalid request must not start a run")

    monkeypatch.setattr(api, "execute", unexpected_execution)
    client = TestClient(api.app, raise_server_exceptions=False)
    response = client.post("/api/runs", content=body, headers={
        "Authorization": f"Bearer {api.REVIEW_KEY}", "Content-Type": "application/json"})
    assert response.status_code == 422, response.text
    assert response.json()["detail"]
    json.dumps(response.json(), allow_nan=False).encode("utf-8")
    assert client.post("/api/runs", json={"scenario_id": "missing"}, headers={
        "Authorization": f"Bearer {api.REVIEW_KEY}"}).status_code == 404


def test_invalid_request_does_not_echo_private_free_text():
    client = TestClient(api.app, raise_server_exceptions=False)
    response = client.post("/api/runs", json={
        "scenario_id": {"email": "person@example.invalid", "notes": "Bearer private-test-value"}},
        headers={"Authorization": f"Bearer {api.REVIEW_KEY}"})
    assert response.status_code == 422
    assert "person@example.invalid" not in response.text
    assert "private-test-value" not in response.text
    assert "[REDACTED]" in response.text


@pytest.mark.parametrize("private_key", [
    "private.person@example.invalid", "Bearer opaque-fixture-value", "310-555-0188",
])
def test_invalid_request_does_not_echo_private_json_keys(monkeypatch, private_key):
    async def unexpected_execution(*args, **kwargs):
        pytest.fail("Invalid input must not start a run")

    monkeypatch.setattr(api, "execute", unexpected_execution)
    client = TestClient(api.app, raise_server_exceptions=False)
    response = client.post("/api/runs", json={"scenario_id": {private_key: "ordinary"}},
        headers={"Authorization": f"Bearer {api.REVIEW_KEY}"})
    assert response.status_code == 422
    assert private_key not in response.text
    assert "[REDACTED" in response.text
