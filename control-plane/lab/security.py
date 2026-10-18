"""Validate and sanitize untrusted data before model use or trace storage."""
import re
import json
import math

SENSITIVE = re.compile(r"(^|_)(token|password|secret|email|phone|contact|ssn|api_?key|authorization|home_address|personal_address)(_|$)", re.I)
# Start once per token so long identifiers do not trigger a scan at every character.
EMAIL = re.compile(r"(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.I)
PHONE = re.compile(r"(?<!\w)(?:\+1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\w)")
MAX_TEXT_LENGTH = 32768
TRUNCATION_MARKER = "[TRUNCATED]"


def strict_json(value):
    """Reject nonstandard numbers and values that overflow a finite float."""
    def reject_constant(_value):
        raise ValueError("JSON numbers must be finite")

    def finite_float(text):
        result = float(text)
        if not math.isfinite(result):
            raise ValueError("JSON numbers must be finite")
        return result

    return json.loads(value, parse_constant=reject_constant, parse_float=finite_float)


def storage_text(value):
    """Keep invalid Unicode visible without breaking PostgreSQL trace storage."""
    return re.sub(r"[\ud800-\udfff]", "[INVALID_UNICODE]", value).replace("\x00", "[NUL]")


def _redact_text(value):
    return PHONE.sub("[REDACTED PHONE]", BEARER.sub("[REDACTED CREDENTIAL]", EMAIL.sub("[REDACTED EMAIL]", value)))


def sanitize(value, path="", redactions=None, truncations=None):
    redactions = redactions if redactions is not None else []
    truncations = truncations if truncations is not None else []
    if isinstance(value, float) and not math.isfinite(value):
        # Keep malformed numbers visible without breaking JSON storage or
        # treating an input error as an attempt to disclose private information.
        return "[INVALID_NUMBER]"
    if isinstance(value, dict):
        output = {}
        for key, item in value.items():
            raw_key = storage_text(key) if isinstance(key, str) else "[INVALID_KEY]"
            key = _redact_text(raw_key)
            location = f"{path}.{key}" if path else key
            if key != raw_key:
                redactions.append({"path": location, "reason": "sensitive_key"})
            normalized_key = re.sub(r"(?<![A-Z])([A-Z]+)([A-Z][a-z])", r"\1_\2", raw_key)
            normalized_key = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", normalized_key).replace("-", "_")
            if SENSITIVE.search(normalized_key):
                output[key] = "[REDACTED]"
                redactions.append({"path": location, "reason": "sensitive_field"})
            else:
                output[key] = sanitize(item, location, redactions, truncations)
        return output
    if isinstance(value, (list, tuple)):
        return [sanitize(item, f"{path}[{index}]", redactions, truncations) for index, item in enumerate(value)]
    if isinstance(value, str):
        value = storage_text(value)
        output = _redact_text(value)
        if output != value:
            redactions.append({"path": path, "reason": "sensitive_text"})
        if len(output) > MAX_TEXT_LENGTH:
            truncations.append({"path": path, "reason": "text_limit", "original_length": len(output),
                                "retained_length": MAX_TEXT_LENGTH})
            return output[:MAX_TEXT_LENGTH - len(TRUNCATION_MARKER)] + TRUNCATION_MARKER
        return output
    if value is None or isinstance(value, (bool, int, float)):
        return value
    # An object's representation may contain private details. Use a fixed marker
    # rather than inspecting it when a local caller supplies unsupported data.
    return "[INVALID_VALUE]"
