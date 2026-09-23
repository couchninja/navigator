from __future__ import annotations

import asyncio
import gzip
import json
import mimetypes
import sys
import uuid
import zlib
from collections import deque
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager, suppress
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import parse_qs

from astropy import units as u

from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.simulation_clock import (
    set_time_scale_preset,
    simulation_time,
    sync_to_realtime,
    time_scale_status_payload,
)
from simulate.astronomy.utils.ephemeris import observer_surface_vector_and_euler_angles_for_target
from simulate.astronomy.web_scene import scene_snapshot_payload

if TYPE_CHECKING:
    from gpio.button_menu import ButtonMenu
    from gpio.button_menu_host import HostButtonMenu

    ButtonTargetSource = ButtonMenu | HostButtonMenu
else:
    ButtonTargetSource = object

WEB_HOST = "0.0.0.0"
WEB_PORT_LINUX = 8765
WEB_PORT_DARWIN = 18765


def web_port_for_platform(platform: str) -> int:
    # Cursor often binds localhost:8765 on macOS; use a distinct port for local dev.
    if platform == "darwin":
        return WEB_PORT_DARWIN
    return WEB_PORT_LINUX


WEB_PORT = web_port_for_platform(sys.platform)
LOG_LINE_LIMIT = 200
_STATUS_POLL_MS = 2000
_VIEWER_DIST = Path(__file__).resolve().parent / "web_viewer" / "dist"
_NO_STORE_HEADERS = {"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"}
_COMPRESS_MIN_BYTES = 512
_navigator_session_id: str | None = None

_NO_COMPRESS_CONTENT_TYPES = frozenset(
    {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
    }
)

_BODY_TARGETS = frozenset(
    {
        PointingTarget.SUN,
        PointingTarget.MOON,
        PointingTarget.MILKY_WAY_CENTER,
        PointingTarget.ISS,
    }
)

_TARGET_BUTTON_COLUMNS: tuple[tuple[PointingTarget, ...], ...] = (
    (
        PointingTarget.SUN,
        PointingTarget.MOON,
        PointingTarget.MILKY_WAY_CENTER,
        PointingTarget.ISS,
    ),
    (
        PointingTarget.EARTH_ROTATION,
        PointingTarget.SUN_ORBIT,
        PointingTarget.MILKY_WAY_ORBIT,
        PointingTarget.CMB_DIPOLE,
    ),
)

_INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="Cache-Control" content="no-store">
  <meta name="navigator-session" content="__NAVIGATOR_SESSION__">
  <title>Earth-sun viewer</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0f1419;
      --card: #1a2332;
      --text: #e8eef4;
      --muted: #8b9aab;
      --accent: #3d9cf0;
      --log-bg: #0a0e12;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html {
      height: 100%;
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      height: 100dvh;
      max-height: 100dvh;
      overflow: hidden;
      box-sizing: border-box;
    }
    .app-shell {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      gap: 1rem;
      height: 100%;
      min-height: 0;
      max-height: 100%;
      overflow: hidden;
    }
    .app-controls {
      flex: 0 0 auto;
      width: fit-content;
      max-width: 100%;
      min-height: 0;
      position: relative;
      z-index: 1;
      overflow-y: auto;
      padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
        max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
      display: flex;
      flex-direction: column;
    }
    .app-viewer {
      flex: 1 1 0;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
      z-index: 0;
      isolation: isolate;
    }
    #viewer-root {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    @media (max-width: 720px) {
      .app-shell {
        flex-direction: column;
      }
      .app-controls {
        width: 100%;
        flex: 1 1 auto;
      }
      .app-viewer {
        order: -1;
        flex: 0 1 42vh;
        max-height: 42vh;
      }
    }
    .target {
      font-size: clamp(1.75rem, 6vw, 2.25rem);
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: 0.5rem;
    }
    .viewer-options {
      margin-bottom: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .viewer-options-label {
      font-size: 0.8125rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .viewer-option {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 1rem;
      cursor: pointer;
      user-select: none;
    }
    .viewer-option input {
      width: 1.1rem;
      height: 1.1rem;
      cursor: pointer;
    }
    .speed {
      font-size: 1.125rem;
      color: var(--muted);
      margin-bottom: 1.25rem;
      min-height: 1.5em;
    }
    .target-buttons-label {
      font-size: 0.875rem;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    .target-buttons {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
      width: max-content;
      max-width: 100%;
    }
    .target-buttons-col {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      flex: 1 1 0;
      min-width: 0;
    }
    button.target-btn {
      padding: 0.75rem 0.65rem;
      font-size: 0.9375rem;
      font-weight: 600;
      border: 1px solid rgba(61, 156, 240, 0.45);
      border-radius: 10px;
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      touch-action: manipulation;
      width: 100%;
      text-align: center;
    }
    button.target-btn.active {
      border-color: var(--accent);
      background: rgba(61, 156, 240, 0.22);
    }
    button.target-btn:active { opacity: 0.85; }
    .time-scale {
      margin-bottom: 1.25rem;
    }
    .time-scale-label {
      font-size: 0.875rem;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    .time-scale-buttons {
      display: flex;
      flex-direction: column;
      gap: 0;
      width: max-content;
      max-width: 100%;
    }
    button.time-scale {
      margin: 0;
      padding: 0.75rem 0.5rem;
      font-size: 0.8125rem;
      font-weight: 600;
      border: 1px solid rgba(61, 156, 240, 0.45);
      border-radius: 0;
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      touch-action: manipulation;
      white-space: nowrap;
    }
    button.time-scale + button.time-scale {
      margin-top: -1px;
    }
    .time-scale-buttons button.time-scale:first-child {
      border-radius: 10px 10px 0 0;
    }
    .time-scale-buttons button.time-scale:last-child {
      border-radius: 0 0 10px 10px;
    }
    button.time-scale.active {
      border-color: var(--accent);
      background: rgba(61, 156, 240, 0.22);
    }
    button.time-scale.time-scale-now {
      border-color: rgba(120, 220, 160, 0.45);
    }
    button.time-scale:active { opacity: 0.85; }
    details.logs-panel {
      width: max-content;
      max-width: 100%;
    }
    details.logs-panel summary.logs-label {
      font-size: 0.875rem;
      color: var(--muted);
      margin-bottom: 0.5rem;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    details.logs-panel summary.logs-label::-webkit-details-marker {
      display: none;
    }
    details.logs-panel summary.logs-label::before {
      content: "▸ ";
      display: inline-block;
      width: 1em;
    }
    details.logs-panel[open] summary.logs-label::before {
      content: "▾ ";
    }
    details.logs-panel[open] summary.logs-label {
      margin-bottom: 0.5rem;
    }
    pre.logs {
      margin: 0;
      padding: 0.75rem;
      background: var(--log-bg);
      border-radius: 8px;
      font-size: 0.75rem;
      line-height: 1.45;
      overflow: auto;
      max-height: min(45vh, 18rem);
      min-height: 6rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .server-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.8125rem;
      color: var(--muted);
      margin-bottom: 1rem;
    }
    .server-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }
    .server-status.connected {
      color: #78dc90;
    }
    .server-status.connected .server-status-dot {
      background: #78dc90;
    }
    .server-status.disconnected {
      color: #f08080;
    }
    .server-status.disconnected .server-status-dot {
      background: #f08080;
    }
  </style>
</head>
<body>
  <div class="app-shell">
  <div class="app-controls">
  <div class="server-status connecting" id="server-status" role="status">
    <span class="server-status-dot" aria-hidden="true"></span>
    <span id="server-status-text">Connecting…</span>
  </div>
  <div class="target-buttons-label">Pointing target</div>
  <div class="target-buttons" id="target-buttons">
__TARGET_BUTTONS__
  </div>
  <div class="target" id="target">—</div>
  <div class="speed" id="speed"></div>
  <div class="time-scale">
    <div class="time-scale-label">Simulation time</div>
    <div class="time-scale-buttons">
      <button type="button" class="time-scale" data-preset="realtime">Realtime</button>
      <button type="button" class="time-scale" data-preset="minute">1 min / s</button>
      <button type="button" class="time-scale" data-preset="hour">1 hour / s</button>
      <button type="button" class="time-scale" data-preset="day">1 day / s</button>
      <button type="button" class="time-scale" data-preset="month">1 month / s</button>
      <button type="button" class="time-scale time-scale-now" data-preset="now">Now (realtime)</button>
    </div>
  </div>
  <div class="viewer-options">
    <div class="viewer-options-label">Viewer</div>
    <label class="viewer-option">
      <input type="checkbox" id="legacy-orbit-lines-control" />
      Ephemeris orbit lines
    </label>
    <label class="viewer-option">
      <input type="checkbox" id="parametric-orbit-lines-control" checked />
      Keplerian / TLE orbit lines
    </label>
  </div>
  <details class="logs-panel">
    <summary class="logs-label">Log</summary>
    <pre class="logs" id="logs"></pre>
  </details>
  </div>
  <div class="app-viewer">
  <div id="viewer-root"></div>
  <script type="module" src="__VIEWER_SCRIPT__"></script>
  </div>
  </div>
  <script>
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) {
          void reg.unregister();
        }
      });
    }

    const targetEl = document.getElementById("target");
    const speedEl = document.getElementById("speed");
    const logsEl = document.getElementById("logs");
    const logsPanel = document.querySelector("details.logs-panel");
    const serverStatusEl = document.getElementById("server-status");
    const serverStatusTextEl = document.getElementById("server-status-text");
    const timeScaleButtons = document.querySelectorAll("button.time-scale");
    const targetButtons = document.querySelectorAll("button.target-btn");

    function applyTargetUi(data) {
      targetEl.textContent = data.target_label;
      for (const btn of targetButtons) {
        btn.classList.toggle("active", btn.dataset.target === data.target);
      }
    }

    function applyTimeScaleUi(timeScale) {
      for (const btn of timeScaleButtons) {
        const preset = btn.dataset.preset;
        if (preset === "now") {
          btn.classList.remove("active");
          continue;
        }
        btn.classList.toggle("active", preset === timeScale.preset);
      }
    }

    function publishStatus(data) {
      window.__navigatorLastStatus = data;
      window.dispatchEvent(new CustomEvent("navigator-status", { detail: data }));
    }

    function applyServerConnection(state) {
      serverStatusEl.classList.remove("connecting", "connected", "disconnected");
      serverStatusEl.classList.add(state);
      const labels = {
        connecting: "Connecting…",
        connected: "Server connected",
        disconnected: "Server unreachable",
      };
      serverStatusTextEl.textContent = labels[state];
    }

    async function setTimeScale(preset) {
      for (const btn of timeScaleButtons) {
        btn.disabled = true;
      }
      try {
        await fetch("/api/time-scale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset }),
        });
        await refresh();
      } finally {
        for (const btn of timeScaleButtons) {
          btn.disabled = false;
        }
      }
    }

    for (const btn of timeScaleButtons) {
      btn.addEventListener("click", () => setTimeScale(btn.dataset.preset));
    }

    function logsOpen() {
      return logsPanel.hasAttribute("open");
    }

    let navigatorSession = null;
    const pageNavigatorSession =
      document.querySelector('meta[name="navigator-session"]')?.getAttribute("content") ?? null;

    async function refresh() {
      const url = logsOpen() ? "/api/status?logs=1" : "/api/status";
      try {
        const res = await fetch(url);
        if (!res.ok) {
          applyServerConnection("disconnected");
          return;
        }
        const data = await res.json();
        applyServerConnection("connected");
        applyTargetUi(data);
        applyTimeScaleUi(data.time_scale);
        if (data.speed_km_h != null) {
          speedEl.textContent = "Surface speed: " + data.speed_km_h.toFixed(2) + " km/h";
        } else {
          speedEl.textContent = "";
        }
        if (logsOpen()) {
          logsEl.textContent = (data.logs || []).join("\\n");
          logsEl.scrollTop = logsEl.scrollHeight;
        }
        if (navigatorSession === null) {
          if (
            pageNavigatorSession !== null &&
            data.session !== pageNavigatorSession
          ) {
            location.reload();
            return;
          }
          navigatorSession = data.session;
        } else if (data.session !== navigatorSession) {
          location.reload();
          return;
        }
        publishStatus(data);
      } catch {
        applyServerConnection("disconnected");
      }
    }

    logsPanel.addEventListener("toggle", () => {
      if (logsOpen()) {
        void refresh();
      }
    });

    async function setTarget(target) {
      for (const btn of targetButtons) {
        btn.disabled = true;
      }
      try {
        await fetch("/api/target", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        });
        await refresh();
      } finally {
        for (const btn of targetButtons) {
          btn.disabled = false;
        }
      }
    }

    for (const btn of targetButtons) {
      btn.addEventListener("click", () => setTarget(btn.dataset.target));
    }

    refresh();
    setInterval(refresh, __POLL_MS__);
  </script>
</body>
</html>
"""


class LogBuffer:
    def __init__(self, *, maxlen: int = LOG_LINE_LIMIT) -> None:
        self._lines: deque[str] = deque(maxlen=maxlen)

    def append_line(self, line: str) -> None:
        if line:
            self._lines.append(line)

    def lines(self) -> list[str]:
        return list(self._lines)


@contextmanager
def capture_stdout(log_buffer: LogBuffer) -> Iterator[None]:
    original = sys.stdout
    pending = ""

    def on_line(line: str) -> None:
        log_buffer.append_line(line)

    class Tee:
        def write(self, data: str) -> None:
            nonlocal pending
            original.write(data)
            pending += data
            while "\n" in pending:
                line, pending = pending.split("\n", 1)
                on_line(line)

        def flush(self) -> None:
            nonlocal pending
            original.flush()
            if pending:
                on_line(pending)
                pending = ""

        def isatty(self) -> bool:
            return original.isatty()

    sys.stdout = Tee()
    try:
        yield
    finally:
        sys.stdout = original


def begin_navigator_session() -> str:
    global _navigator_session_id
    _navigator_session_id = uuid.uuid4().hex
    return _navigator_session_id


def navigator_session_id() -> str:
    if _navigator_session_id is None:
        begin_navigator_session()
    assert _navigator_session_id is not None
    return _navigator_session_id


def _target_button_html(target: PointingTarget) -> str:
    return f'      <button type="button" class="target-btn" data-target="{target.value}">{target.label}</button>'


def _target_buttons_html() -> str:
    lines: list[str] = []
    for column in _TARGET_BUTTON_COLUMNS:
        lines.append('    <div class="target-buttons-col">')
        for target in column:
            lines.append(_target_button_html(target))
        lines.append("    </div>")
    return "\n".join(lines)


def _index_html() -> str:
    session = navigator_session_id()
    return (
        _INDEX_HTML.replace("__VIEWER_SCRIPT__", f"/viewer.js?v={session}")
        .replace("__NAVIGATOR_SESSION__", session)
        .replace("__POLL_MS__", str(_STATUS_POLL_MS))
        .replace("__TARGET_BUTTONS__", _target_buttons_html())
    )


def _request_path(path: str) -> str:
    return path.split("?", 1)[0]


def _scene_include_ephemeris_orbit_paths(path: str) -> bool:
    if "?" not in path:
        return True
    query = parse_qs(path.split("?", 1)[1], keep_blank_values=True)
    values = query.get("ephemeris_orbits")
    if not values:
        return True
    flag = values[-1].lower()
    return flag not in ("", "0", "false", "no", "off")


def _status_include_logs(path: str) -> bool:
    if "?" not in path:
        return False
    query = parse_qs(path.split("?", 1)[1], keep_blank_values=True)
    values = query.get("logs")
    if not values:
        return False
    flag = values[-1].lower()
    return flag in ("", "1", "true", "yes")


def _status_payload(
    buttons: ButtonTargetSource,
    log_buffer: LogBuffer,
    *,
    include_logs: bool,
) -> dict[str, object]:
    target = buttons.selected_button["target"]
    _surface, _euler, speed_au_s = observer_surface_vector_and_euler_angles_for_target(simulation_time(), target)
    speed_km_h: float | None = None
    if target not in _BODY_TARGETS:
        speed_km_s = speed_au_s * (1 * u.au).to_value(u.km)
        speed_km_h = float(speed_km_s * 3600.0)
    payload: dict[str, object] = {
        "target": target.value,
        "target_label": target.label,
        "speed_km_h": speed_km_h,
    }
    if include_logs:
        payload["logs"] = log_buffer.lines()
    return payload


def _web_status_payload(
    buttons: ButtonTargetSource,
    log_buffer: LogBuffer,
    *,
    include_logs: bool,
) -> dict[str, object]:
    payload = _status_payload(buttons, log_buffer, include_logs=include_logs)
    payload["time_scale"] = time_scale_status_payload()
    payload["session"] = navigator_session_id()
    return payload


def _choose_content_encoding(accept_header: str) -> str | None:
    codings: list[tuple[float, str]] = []
    for part in accept_header.split(","):
        part = part.strip()
        if not part:
            continue
        if ";q=" in part:
            name, q_str = part.split(";q=", 1)
            name = name.strip()
            try:
                quality = float(q_str.strip())
            except ValueError:
                quality = 0.0
        else:
            name = part
            quality = 1.0
        if name in ("gzip", "deflate") and quality > 0.0:
            codings.append((quality, name))
    if not codings:
        return None
    codings.sort(key=lambda item: (-item[0], 0 if item[1] == "gzip" else 1))
    return codings[0][1]


def _accept_encoding_from_header(header: bytes) -> str | None:
    for line in header.split(b"\r\n")[1:]:
        if line.lower().startswith(b"accept-encoding:"):
            value = line.split(b":", 1)[1].decode("latin-1").strip()
            return _choose_content_encoding(value)
    return None


def _compress_body(body: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        return gzip.compress(body, compresslevel=1)
    if encoding == "deflate":
        return zlib.compress(body, level=1)
    raise ValueError(f"unsupported content encoding: {encoding}")


def _compressible_response_body(body: bytes, content_type: str, status: int) -> bool:
    if status == 204 or not body:
        return False
    if len(body) < _COMPRESS_MIN_BYTES:
        return False
    mime = content_type.split(";", 1)[0].strip().lower()
    return mime not in _NO_COMPRESS_CONTENT_TYPES


async def _read_request(reader: asyncio.StreamReader) -> tuple[str, str, bytes, str | None]:
    header = await reader.readuntil(b"\r\n\r\n")
    first_line = header.split(b"\r\n", 1)[0].decode("utf-8", errors="replace")
    parts = first_line.split()
    if len(parts) < 2:
        raise ValueError("bad request line")
    method, path = parts[0], parts[1]
    accept_encoding = _accept_encoding_from_header(header)
    body = b""
    content_length = 0
    for line in header.split(b"\r\n")[1:]:
        if line.lower().startswith(b"content-length:"):
            content_length = int(line.split(b":", 1)[1].strip())
            break
    if content_length > 0:
        body = await reader.readexactly(content_length)
    return method, path, body, accept_encoding


def _apply_time_scale_preset(preset: str) -> None:
    if preset == "now":
        sync_to_realtime()
        return
    set_time_scale_preset(preset)


def _legacy_pwa_route(route: str) -> bool:
    if route == "/manifest.webmanifest":
        return True
    if route in {"/sw.js", "/service-worker.js"}:
        return True
    name = route.lstrip("/").lower()
    return name.startswith("workbox-")


def _viewer_asset(path: str) -> tuple[bytes, str] | None:
    path = _request_path(path)
    if not path.startswith("/"):
        return None
    relative = path.lstrip("/")
    if not relative or any(part == ".." for part in relative.split("/")):
        return None
    leaf = relative.split("/")[-1].lower()
    if leaf == "index.html" or leaf.endswith(".webmanifest") or leaf.startswith("workbox-"):
        return None
    if leaf in {"sw.js", "service-worker.js"}:
        return None
    file_path = (_VIEWER_DIST / relative).resolve()
    dist_root = _VIEWER_DIST.resolve()
    if not str(file_path).startswith(str(dist_root)) or not file_path.is_file():
        return None
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return file_path.read_bytes(), content_type


def _http_response(
    status: int,
    body: bytes,
    content_type: str,
    *,
    extra_headers: dict[str, str] | None = None,
    accept_encoding: str | None = None,
) -> bytes:
    reason = {
        200: "OK",
        204: "No Content",
        400: "Bad Request",
        404: "Not Found",
        405: "Method Not Allowed",
    }[status]
    response_body = body
    content_encoding: str | None = None
    if accept_encoding and _compressible_response_body(body, content_type, status):
        compressed = _compress_body(body, accept_encoding)
        if len(compressed) < len(body):
            response_body = compressed
            content_encoding = accept_encoding
    header = f"HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {len(response_body)}\r\n"
    if content_encoding is not None:
        header += f"Content-Encoding: {content_encoding}\r\n"
    for key, value in (extra_headers or {}).items():
        header += f"{key}: {value}\r\n"
    header += "Connection: close\r\n\r\n"
    return header.encode("ascii") + response_body


def _http_redirect(location: str) -> bytes:
    header = f"HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    return header.encode("ascii")


_CLEAR_SW_HEADERS = {**_NO_STORE_HEADERS, "Clear-Site-Data": '"storage"'}


async def _handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    buttons: ButtonTargetSource,
    log_buffer: LogBuffer,
) -> None:
    try:
        method, path, body, accept_encoding = await _read_request(reader)
        route = _request_path(path)
        if route == "/" and method == "GET":
            body = _index_html().encode("utf-8")
            writer.write(
                _http_response(
                    200,
                    body,
                    "text/html; charset=utf-8",
                    extra_headers=_NO_STORE_HEADERS,
                    accept_encoding=accept_encoding,
                )
            )
        elif route == "/index.html" and method == "GET":
            writer.write(_http_redirect("/"))
        elif method == "GET" and _legacy_pwa_route(route):
            writer.write(
                _http_response(
                    404,
                    b"removed",
                    "text/plain",
                    extra_headers=_CLEAR_SW_HEADERS,
                    accept_encoding=accept_encoding,
                )
            )
        elif method == "GET" and (asset := _viewer_asset(path)) is not None:
            body, content_type = asset
            writer.write(
                _http_response(
                    200,
                    body,
                    content_type,
                    extra_headers=_NO_STORE_HEADERS,
                    accept_encoding=accept_encoding,
                )
            )
        elif route == "/api/navigator-session" and method == "GET":
            payload = json.dumps({"session": navigator_session_id()}).encode("utf-8")
            writer.write(_http_response(200, payload, "application/json", accept_encoding=accept_encoding))
        elif route == "/api/status" and method == "GET":
            payload = json.dumps(
                _web_status_payload(buttons, log_buffer, include_logs=_status_include_logs(path))
            ).encode("utf-8")
            writer.write(_http_response(200, payload, "application/json", accept_encoding=accept_encoding))
        elif route == "/api/scene" and method == "GET":
            target = buttons.selected_button["target"]
            include_ephemeris = _scene_include_ephemeris_orbit_paths(path)
            snapshot = await asyncio.to_thread(
                lambda: scene_snapshot_payload(
                    target,
                    include_ephemeris_orbit_paths=include_ephemeris,
                ),
            )
            payload = json.dumps(snapshot).encode("utf-8")
            writer.write(_http_response(200, payload, "application/json", accept_encoding=accept_encoding))
        elif route == "/api/time-scale" and method == "GET":
            payload = json.dumps(time_scale_status_payload()).encode("utf-8")
            writer.write(_http_response(200, payload, "application/json", accept_encoding=accept_encoding))
        elif route == "/api/time-scale" and method == "POST":
            try:
                data = json.loads(body.decode("utf-8"))
                preset = data["preset"]
                if not isinstance(preset, str):
                    raise ValueError("preset must be a string")
                _apply_time_scale_preset(preset)
            except (KeyError, ValueError, json.JSONDecodeError):
                writer.write(_http_response(400, b"bad request", "text/plain", accept_encoding=accept_encoding))
            else:
                payload = json.dumps(time_scale_status_payload()).encode("utf-8")
                writer.write(_http_response(200, payload, "application/json", accept_encoding=accept_encoding))
        elif route == "/api/target" and method == "POST":
            try:
                data = json.loads(body.decode("utf-8"))
                target_value = data["target"]
                if not isinstance(target_value, str):
                    raise ValueError("target must be a string")
                buttons.select_target(PointingTarget(target_value))
            except (KeyError, ValueError, json.JSONDecodeError):
                writer.write(_http_response(400, b"bad request", "text/plain", accept_encoding=accept_encoding))
            else:
                writer.write(_http_response(204, b"", "text/plain", accept_encoding=accept_encoding))
        elif method == "GET":
            writer.write(_http_response(404, b"Not found", "text/plain", accept_encoding=accept_encoding))
        else:
            writer.write(
                _http_response(
                    405,
                    b"Method not allowed",
                    "text/plain",
                    accept_encoding=accept_encoding,
                )
            )
    except (asyncio.IncompleteReadError, ConnectionResetError, ValueError):
        pass
    finally:
        writer.close()
        with suppress(Exception):
            await writer.wait_closed()


@asynccontextmanager
async def run_web_ui(buttons: ButtonTargetSource, log_buffer: LogBuffer) -> AsyncIterator[None]:
    async def client_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _handle_client(reader, writer, buttons, log_buffer)

    server = await asyncio.start_server(client_handler, WEB_HOST, WEB_PORT)
    print(f"Navigator web UI at http://localhost:{WEB_PORT}")
    try:
        yield
    finally:
        server.close()
        await server.wait_closed()
