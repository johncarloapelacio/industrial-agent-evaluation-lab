"""Create a source distribution, excluding credentials and machine-local state."""
from pathlib import Path
import argparse
import os
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {".git", ".venv", ".tools", "node_modules", "dist", "__pycache__", ".pytest_cache", "test-results", "playwright-report", "artifacts"}
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "local" / "industrial-agent-evaluation-lab.zip")
args = parser.parse_args()
output = args.output.resolve()
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for directory, folders, files in os.walk(ROOT):
        folders[:] = sorted(folder for folder in folders if folder not in EXCLUDED)
        for name in sorted(files):
            file = Path(directory) / name
            if (name.startswith(".env") and name != ".env.example") or file.suffix in (".log", ".pyc", ".zip", ".tsbuildinfo") or name == "CONTRACT.md":
                continue
            archive.write(file, Path("industrial-agent-evaluation-lab") / file.relative_to(ROOT))
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert all(not set(Path(name).parts) & EXCLUDED for name in archive.namelist())
    assert not any(Path(name).name.startswith(".env") and Path(name).name != ".env.example" for name in archive.namelist())
    count = len(archive.namelist())
print(f"Packaged {count} files: {output} ({output.stat().st_size / 1024 / 1024:.1f} MiB)")
