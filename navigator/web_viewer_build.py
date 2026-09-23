"""Build ``navigator/web_viewer/dist/viewer.js`` (requires pixi ``nodejs`` / ``npm`` on PATH)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

_WEB_VIEWER_DIR = Path(__file__).resolve().parent / "web_viewer"
_VIEWER_JS = _WEB_VIEWER_DIR / "dist" / "viewer.js"


def build_web_viewer_if_ready() -> None:
    if shutil.which("npm") is None:
        raise RuntimeError("npm not found on PATH; use pixi run (nodejs is a pixi dependency)")
    if not _web_viewer_build_is_stale():
        return
    print("Ensuring navigator web viewer npm dependencies...")
    subprocess.run(
        ["npm", "install"],
        cwd=_WEB_VIEWER_DIR,
        check=True,
    )
    print("Building navigator web viewer (viewer.js)...")
    subprocess.run(
        ["npm", "run", "build"],
        cwd=_WEB_VIEWER_DIR,
        check=True,
    )
    _remove_standalone_viewer_shell_from_dist()


def _remove_standalone_viewer_shell_from_dist() -> None:
    dist = _WEB_VIEWER_DIR / "dist"
    if not dist.is_dir():
        return
    for path in dist.iterdir():
        if not path.is_file():
            continue
        name = path.name.lower()
        if name == "index.html":
            path.unlink()
            continue
        if name.endswith(".webmanifest") or name.startswith("workbox") or name in {"sw.js", "service-worker.js"}:
            path.unlink()


def _web_viewer_build_is_stale() -> bool:
    if not _VIEWER_JS.is_file():
        return True
    built_at = _VIEWER_JS.stat().st_mtime
    for path in _web_viewer_source_paths():
        if path.is_file() and path.stat().st_mtime > built_at:
            return True
    return False


def _web_viewer_source_paths() -> list[Path]:
    root = _WEB_VIEWER_DIR
    paths = [
        root / "index.html",
        root / "package.json",
        root / "package-lock.json",
        root / "tsconfig.json",
        root / "vite.config.ts",
    ]
    for pattern in ("public/**", "src/**"):
        paths.extend(p for p in root.glob(pattern) if p.is_file())
    return paths
