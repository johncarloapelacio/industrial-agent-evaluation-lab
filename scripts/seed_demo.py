"""Create and export demonstration runs using the running services."""
import argparse
import json
import os
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--all", action="store_true", help="Run the complete twelve-scenario baseline suite")
parser.add_argument("--output", type=Path, default=Path("artifacts/local/reports"))
args = parser.parse_args()
base = os.getenv("LAB_BASE_URL", "http://127.0.0.1:8000")
headers = {"Content-Type": "application/json", "Authorization": "Bearer " + os.getenv("LAB_REVIEW_KEY", "local-review-key")}
with urllib.request.urlopen(base + "/api/scenarios") as response:
    scenarios = json.load(response)
selected = scenarios if args.all else [item for item in scenarios if item["id"] in ("overheating-stale-sensor", "lost-work-order-response", "technician-note-injection")]
args.output.mkdir(parents=True, exist_ok=True)
for scenario in selected:
    for provider in (["baseline", "careless"] if scenario["id"] == "overheating-stale-sensor" else ["baseline"]):
        request = urllib.request.Request(base + "/api/runs", headers=headers, data=json.dumps({"scenario_id": scenario["id"], "provider": provider}).encode())
        with urllib.request.urlopen(request, timeout=200) as response:
            detail = json.load(response)
        (args.output / f"{scenario['id']}-{provider}.json").write_text(json.dumps(detail, indent=2), encoding="utf-8")
        count = detail["tool_calls"]
        print(f"{scenario['id']} / {provider}: {detail['score']}/100 {'PASS' if detail['passed'] else 'FAIL'} ({count} {'call' if count == 1 else 'calls'})")
