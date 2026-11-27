#!/usr/bin/env python3
"""Build the PeaIndex application shell without reading its data export."""

from __future__ import annotations

import hashlib
import html
import os
from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "demo"
DIST = ROOT / "dist"
ASSETS = ("index.html", "app.js", "styles.css")


def env_file_value(name: str) -> str:
    """Read a simple KEY=value .env file when the process did not set KEY."""
    if name in os.environ:
        return os.environ[name]
    path = ROOT / ".env"
    if not path.is_file():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            return value
    return ""


def asset_version(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def render_index(data_base_url: str, app_version: str, styles_version: str) -> str:
    source = (SOURCE / "index.html").read_text(encoding="utf-8")
    meta = f'<meta name="peaindex-data-base-url" content="{html.escape(data_base_url, quote=True)}" />'
    pattern = r'\s*<meta name="peaindex-data-base-url"[^>]*?/?>'
    if re.search(pattern, source):
        source = re.sub(pattern, "\n    " + meta, source, count=1)
    else:
        source = source.replace('    <meta name="viewport"', f"    {meta}\n    <meta name=\"viewport\"")
    source = re.sub(r'"styles\.css(?:\?v=[a-f0-9]+)?"', f'"styles.css?v={styles_version}"', source)
    source = re.sub(r'"app\.js(?:\?v=[a-f0-9]+)?"', f'"app.js?v={app_version}"', source)
    return source


def main() -> int:
    missing = [name for name in ASSETS if not (SOURCE / name).is_file()]
    if missing:
        raise SystemExit(f"Missing application asset(s): {', '.join(missing)}")
    DIST.mkdir(exist_ok=True)
    for child in list(DIST.iterdir()):
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    app_version = asset_version(SOURCE / "app.js")
    styles_version = asset_version(SOURCE / "styles.css")
    (DIST / "app.js").write_bytes((SOURCE / "app.js").read_bytes())
    (DIST / "styles.css").write_bytes((SOURCE / "styles.css").read_bytes())
    (DIST / "index.html").write_text(
        render_index(env_file_value("PEAINDEX_DATA_BASE_URL"), app_version, styles_version),
        encoding="utf-8",
    )
    files = [path for path in DIST.rglob("*") if path.is_file()]
    size = sum(path.stat().st_size for path in files)
    print(f"Built {len(files)} application files ({size:,} bytes / {size / 1024:.1f} KiB) in {DIST.relative_to(ROOT)}/")
    for path in sorted(files):
        print(f"  {path.relative_to(DIST)} {path.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
