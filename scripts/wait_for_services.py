"""Cross-platform readiness check used by CI and local development."""
import os
import time
import urllib.request

url = os.getenv("LAB_BASE_URL", "http://127.0.0.1:8000") + "/api/health"
for attempt in range(60):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            if response.status == 200:
                print("Control plane, tool API and PostgreSQL are healthy.")
                break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit("Services did not become healthy within the readiness budget")
