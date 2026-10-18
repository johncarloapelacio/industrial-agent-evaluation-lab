"""A small durable run repository; operational entities belong to the tool service."""
import psycopg
from psycopg.types.json import Jsonb
from .config import DATABASE_URL


def connect():
    return psycopg.connect(DATABASE_URL, connect_timeout=5, options="-c statement_timeout=10000")


def initialize():
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS lab_runs (
                id uuid PRIMARY KEY,
                created_at timestamptz NOT NULL DEFAULT now(),
                detail jsonb NOT NULL
            )
        """)


def save(detail):
    with connect() as db:
        db.execute("""INSERT INTO lab_runs(id, detail) VALUES (%s,%s)
            ON CONFLICT(id) DO UPDATE SET detail=EXCLUDED.detail""",
                   (detail["id"], Jsonb(detail)))


def get(run_id):
    with connect() as db:
        row = db.execute("SELECT detail FROM lab_runs WHERE id=%s", (run_id,)).fetchone()
    return row[0] if row else None


SUMMARY_KEYS = ("id", "scenario_id", "scenario_name", "category", "status", "provider",
                "score", "passed", "created_at", "tool_calls", "retries", "duration_ms", "replay_of")


def summary(detail):
    return {key: detail.get(key) for key in SUMMARY_KEYS}


def list_runs():
    with connect() as db:
        rows = db.execute("SELECT detail FROM lab_runs ORDER BY created_at DESC LIMIT 200").fetchall()
    return [summary(row[0]) for row in rows]


def list_incomplete():
    """Startup recovery must include all unfinished runs, beyond the review-list limit."""
    with connect() as db:
        rows = db.execute("SELECT detail FROM lab_runs WHERE detail->>'status'='running' ORDER BY created_at").fetchall()
    return [row[0] for row in rows]
