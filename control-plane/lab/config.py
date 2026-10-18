import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://lab:lab@127.0.0.1:5432/lab")
TOOL_API_URL = os.getenv("TOOL_API_URL", "http://127.0.0.1:3001")
INTERNAL_KEY = os.getenv("LAB_INTERNAL_KEY", "local-internal-key")
REVIEW_KEY = os.getenv("LAB_REVIEW_KEY", "local-review-key")
SCENARIO_DIR = Path(os.getenv("SCENARIO_DIR", str(ROOT / "scenarios")))
MAX_STEPS = min(max(int(os.getenv("MODEL_MAX_STEPS", "24")), 1), 40)
