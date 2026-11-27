#!/usr/bin/env python3
"""Serve the application shell and the published data directory locally."""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_ROOT = ROOT / "dist"
DEFAULT_DATA_ROOT = ROOT / "external-data"
APP_FILES = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8"}


def ensure_app(root: Path) -> None:
    if root == DEFAULT_APP_ROOT:
        subprocess.run([sys.executable, str(ROOT / "scripts/build.py")], check=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "PeaIndexStatic/1.0"

    def _send(self, status: int, body: bytes = b"", content_type: str = "text/plain; charset=utf-8",
              cache_control: str = "no-cache", allow_origin: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        if allow_origin:
            self.send_header("Access-Control-Allow-Origin", allow_origin)
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD")
            self.send_header("Vary", "Origin")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _safe_parts(self, path: str) -> list[str] | None:
        decoded = unquote(path)
        if "\\" in decoded:
            return None
        raw_parts = [part for part in decoded.split("/") if part]
        if any(part in {".", ".."} or part.startswith(".") for part in raw_parts):
            return None
        return raw_parts

    def _file(self, path: Path, content_type: str, *, immutable: bool = False, allow_origin: str = "") -> None:
        if not path.is_file():
            self._send(HTTPStatus.NOT_FOUND, b"Not found\n")
            return
        body = path.read_bytes()
        cache_control = "public, max-age=31536000, immutable" if immutable else "no-cache"
        self._send(HTTPStatus.OK, body, content_type, cache_control, allow_origin)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        split = urlsplit(self.path)
        parts = self._safe_parts(split.path)
        if parts is None:
            self._send(HTTPStatus.NOT_FOUND, b"Not found\n")
            return
        if parts and parts[0] == "data":
            self._serve_data(parts[1:])
            return
        self._serve_app(parts)

    def _serve_app(self, parts: list[str]) -> None:
        relative = parts[0] if parts else "index.html"
        if len(parts) > 1 or relative not in APP_FILES:
            self._send(HTTPStatus.NOT_FOUND, b"Not found\n")
            return
        path = (self.server.app_root / relative).resolve()
        if not path.is_relative_to(self.server.app_root):
            self._send(HTTPStatus.NOT_FOUND, b"Not found\n")
            return
        self._file(path, APP_FILES[relative])

    def _serve_data(self, parts: list[str]) -> None:
        is_catalog = len(parts) == 1 and parts[0] in {"catalog.json", "catalog.json.gz"}
        is_library = len(parts) in {3, 4} and parts[0] == "library" and re.fullmatch(r"[a-f0-9]{20}", parts[1])
        is_shard = bool(is_library and (
            (len(parts) == 3 and parts[2] in {"source-fields.json", "review-adjustments.json", "build-report.json"})
            or (len(parts) == 4 and parts[2] in {"gene", "disease", "evidence"} and parts[3].endswith(".json"))
        ))
        if not (is_catalog or is_shard):
            self._send(HTTPStatus.NOT_FOUND, b"Not found\n")
            return
        path = (self.server.data_root / Path(*parts)).resolve()
        if not path.is_relative_to(self.server.data_root):
            self._send(HTTPStatus.NOT_FOUND, b"Not found\n")
            return
        content_type = "application/gzip" if path.name.endswith(".gz") else "application/json"
        self._file(path, content_type, immutable=is_shard, allow_origin=self.server.allow_origin)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--app-root", type=Path, default=DEFAULT_APP_ROOT)
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA_ROOT)
    parser.add_argument("--cors-origin", default="", help="Origin allowed for /data requests, or *")
    args = parser.parse_args()
    args.app_root = args.app_root.resolve()
    args.data_root = args.data_root.resolve()
    ensure_app(args.app_root)
    Handler.protocol_version = "HTTP/1.1"
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.app_root = args.app_root
    server.data_root = args.data_root
    server.allow_origin = args.cors_origin
    print(f"PeaIndex app at http://{args.host}:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
