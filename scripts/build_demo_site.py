"""Stage the watch page and verified media for static hosting."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, default=ROOT / "artifacts/local/demo-site")
args = parser.parse_args()
output = args.output.resolve()
manifest = json.loads((ROOT / "docs/demo/manifest.json").read_text(encoding="utf-8"))
media = ROOT / "docs/demo" / manifest["media_file"]
if hashlib.sha256(media.read_bytes()).hexdigest() != manifest["media_sha256"]:
    raise SystemExit("The demo video does not match its recorded checksum")

files = {
    "index.html": ROOT / "watch/index.html",
    "styles.css": ROOT / "watch/styles.css",
    "poster.png": ROOT / "docs/demo/poster.png",
    "demo.mp4": media,
}
# Refuse unrelated output so the published artifact cannot include local files.
if output.exists() and any(item.name not in files or not item.is_file() for item in output.iterdir()):
    raise SystemExit("Choose an empty output directory or an existing demo-site build")
output.mkdir(parents=True, exist_ok=True)
for name, source in files.items():
    shutil.copyfile(source, output / name)
print(f"Built watch page with {len(files)} public files: {output}")
