"""Render the Home screen thumbnails of the sample projects (mathengine/samples/<id>.jpg).

    python scripts/sample_thumbnails.py [--out DIR] [--at SECONDS]

Each thumbnail is the frame at 70% of the sample's length (or --at), 480 px wide.
"""
import argparse
import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from mathengine import runtime, samples  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=str(samples.THUMBS))
ap.add_argument("--at", type=float, default=None)
ap.add_argument("--width", type=int, default=480)
opts = ap.parse_args()
out = Path(opts.out)
out.mkdir(parents=True, exist_ok=True)
for info in samples.sample_list():
    doc = samples.sample(info["id"])
    t = opts.at if opts.at is not None else info["duration"] * 0.7
    r = runtime.run(doc, t, render=True, preview_width=opts.width)
    if r.error:
        sys.exit(f"{info['id']}: {r.error['message']}\n{r.error['trace']}")
    problems = [d for d in r.diagnostics if d["level"] == "error"]
    if problems:
        sys.exit(f"{info['id']}: {problems}")
    (out / f"{info['id']}.jpg").write_bytes(base64.b64decode(r.image.split(",", 1)[1]))
    print(info["id"], f"t={t:.1f}s", "warnings:", [d["message"][:80] for d in r.diagnostics])
