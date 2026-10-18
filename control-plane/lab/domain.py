"""Domain evidence selection. Never interpret technician notes as instructions."""
from datetime import datetime, timezone
import math


SNAPSHOT_ENTITIES = ("assets", "telemetry", "manuals", "inventory", "technicians",
                     "reservations", "work_orders", "approval_requests", "audit")


def complete_snapshot(value):
    """Require the collections and row identifiers used by state comparisons."""
    return (isinstance(value, dict)
            and all(isinstance(value.get(entity), list)
                    and all(isinstance(row, dict) and isinstance(row.get("id"), str)
                            and bool(row["id"].strip()) for row in value[entity])
                    for entity in SNAPSHOT_ENTITIES))


def instant(value):
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result
    except (ValueError, TypeError):
        return None


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize_reading(reading):
    if not number(reading.get("temperature")) or not number(reading.get("vibration")):
        return None
    temperature_unit = reading.get("temperature_unit", "").lower().strip()
    vibration_unit = reading.get("vibration_unit", "").lower().strip()
    temperature = reading["temperature"]
    vibration = reading["vibration"]
    if temperature_unit in ("f", "°f", "fahrenheit"):
        temperature = (temperature - 32) * 5 / 9
    elif temperature_unit not in ("c", "°c", "celsius"):
        return None
    if vibration_unit in ("in/s", "ips"):
        vibration *= 25.4
    elif vibration_unit not in ("mm/s", "mm_s"):
        return None
    return {**reading, "temperature_c": temperature, "vibration_mm_s": vibration}


def select_evidence(readings, manuals, clock):
    now = instant(clock)
    fresh = []
    for reading in readings:
        observed = instant(reading.get("observed_at"))
        normalized = normalize_reading(reading)
        if (normalized and observed and now and 0 <= (now - observed).total_seconds() <= 3600
                and reading.get("sensor_status") == "valid"):
            fresh.append(normalized)
    fresh.sort(key=lambda item: instant(item["observed_at"]), reverse=True)
    approved = [manual for manual in manuals if manual.get("approved") is True
                and instant(manual.get("effective_at")) and now
                and instant(manual["effective_at"]) <= now]
    approved.sort(key=lambda item: instant(item["effective_at"]), reverse=True)
    return (fresh[0] if fresh else None, approved[0] if approved else None)
