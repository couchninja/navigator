import gzip
import json
import zlib
from collections.abc import Iterator
from typing import Any, cast

import pytest

from gpio.button_menu_host import HostButtonMenu
from navigator.web_ui import (
    LogBuffer,
    _choose_content_encoding,
    _http_response,
    _index_html,
    _status_include_logs,
    _status_payload,
    _viewer_asset,
    _web_status_payload,
    begin_navigator_session,
    capture_stdout,
    navigator_session_id,
    web_port_for_platform,
)
from simulate.astronomy.constants import PointingTarget


@pytest.fixture
def menu_without_gpio() -> Iterator[HostButtonMenu]:
    menu = HostButtonMenu()
    menu.__enter__()
    yield menu
    menu.__exit__(None, None, None)


def test_index_html_includes_target_buttons() -> None:
    begin_navigator_session()
    html = _index_html()
    session = navigator_session_id()
    assert f'name="navigator-session" content="{session}"' in html
    assert f"/viewer.js?v={session}" in html
    for target in PointingTarget:
        assert f'data-target="{target.value}"' in html
        assert target.label in html
    assert "Next target" not in html
    assert 'id="server-status"' in html
    assert "Server connected" in html
    assert "target-buttons-col" in html
    assert 'timeScale.preset === "realtime"' not in html
    assert "rgba(40, 80, 55" not in html


def test_status_payload_includes_target_and_logs(menu_without_gpio: HostButtonMenu) -> None:
    log_buffer = LogBuffer()
    with capture_stdout(log_buffer):
        print("hello navigator")
    payload = _status_payload(menu_without_gpio, log_buffer, include_logs=True)
    assert payload["target"] == PointingTarget.EARTH_ROTATION.value
    assert payload["target_label"] == "Earth rotation"
    assert payload["speed_km_h"] is not None
    logs = payload["logs"]
    assert isinstance(logs, list)
    assert "hello navigator" in logs


def test_status_payload_omits_speed_for_sun(menu_without_gpio: HostButtonMenu) -> None:
    menu_without_gpio.select_target(PointingTarget.SUN)
    payload = _status_payload(menu_without_gpio, LogBuffer(), include_logs=False)
    assert payload["speed_km_h"] is None


def test_status_payload_omits_logs_when_not_requested(menu_without_gpio: HostButtonMenu) -> None:
    log_buffer = LogBuffer()
    with capture_stdout(log_buffer):
        print("hidden")
    payload = _status_payload(menu_without_gpio, log_buffer, include_logs=False)
    assert "logs" not in payload


def test_status_include_logs_query() -> None:
    assert not _status_include_logs("/api/status")
    assert _status_include_logs("/api/status?logs=1")
    assert _status_include_logs("/api/status?logs")


def test_status_payload_json_serializable(menu_without_gpio: HostButtonMenu) -> None:
    payload = _status_payload(menu_without_gpio, LogBuffer(), include_logs=False)
    json.dumps(payload)


def test_web_status_payload_combines_ui_fields(menu_without_gpio: HostButtonMenu) -> None:
    begin_navigator_session()
    payload = _web_status_payload(menu_without_gpio, LogBuffer(), include_logs=False)
    assert payload["target"] == PointingTarget.EARTH_ROTATION.value
    assert payload["session"] == navigator_session_id()
    time_scale = cast(dict[str, Any], payload["time_scale"])
    assert "preset" in time_scale
    assert time_scale["time_iso"]
    json.dumps(payload)


def test_web_port_differs_on_darwin() -> None:
    assert web_port_for_platform("darwin") == 18765
    assert web_port_for_platform("linux") == 8765


def test_viewer_asset_serves_earth_texture_from_dist() -> None:
    asset = _viewer_asset("/textures/land_shallow_topo_2048.jpg")
    assert asset is not None
    body, content_type = asset
    assert content_type == "image/jpeg"
    assert len(body) > 100_000


def test_viewer_asset_rejects_path_traversal() -> None:
    assert _viewer_asset("/textures/../web_ui.py") is None


def test_viewer_asset_rejects_standalone_shell_files() -> None:
    assert _viewer_asset("/index.html") is None
    assert _viewer_asset("/manifest.webmanifest") is None
    assert _viewer_asset("/workbox-deadbeef.js") is None
    assert _viewer_asset("/sw.js") is None


def test_navigator_session_changes_each_run() -> None:
    first = begin_navigator_session()
    second = begin_navigator_session()
    assert len(first) == 32
    assert len(second) == 32
    assert first != second
    assert navigator_session_id() == second


def test_choose_content_encoding_respects_quality() -> None:
    assert _choose_content_encoding("gzip, deflate, br") == "gzip"
    assert _choose_content_encoding("deflate, gzip;q=0.8") == "deflate"
    assert _choose_content_encoding("deflate;q=0.5, gzip") == "gzip"


def test_http_response_gzip_when_accepted() -> None:
    body = b'{"data":"' + b"x" * 600 + b'"}'
    raw = _http_response(200, body, "application/json", accept_encoding="gzip")
    header, payload = raw.split(b"\r\n\r\n", 1)
    assert b"Content-Encoding: gzip\r\n" in header
    assert gzip.decompress(payload) == body


def test_http_response_skips_small_and_images() -> None:
    small = _http_response(200, b"{}", "application/json", accept_encoding="gzip")
    assert b"Content-Encoding:" not in small

    jpeg = b"\xff\xd8" + b"x" * 600
    image = _http_response(200, jpeg, "image/jpeg", accept_encoding="gzip")
    assert b"Content-Encoding:" not in image


def test_http_response_deflate_when_requested() -> None:
    body = b"alpha " * 200
    raw = _http_response(200, body, "text/plain", accept_encoding="deflate")
    header, payload = raw.split(b"\r\n\r\n", 1)
    assert b"Content-Encoding: deflate\r\n" in header
    assert zlib.decompress(payload) == body
