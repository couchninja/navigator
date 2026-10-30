from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from navigator import navigator_main as nav


def test_gpio_unavailable_on_darwin() -> None:
    with patch.object(nav.sys, "platform", "darwin"):
        assert not nav.gpio_available()
    with patch.object(nav.sys, "platform", "linux"):
        assert nav.gpio_available()


@pytest.mark.asyncio
async def test_navigator_main_uses_host_buttons_and_hub_loop_on_darwin() -> None:
    with (
        patch.object(nav.sys, "platform", "darwin"),
        patch.object(nav, "build_web_viewer_if_ready"),
        patch.object(nav, "begin_navigator_session"),
        patch.object(nav, "run_navigator_loop", new=AsyncMock()) as hub_loop,
        patch.object(nav, "ButtonMenu") as menu_cls,
        patch.object(nav, "ObserverSpeedDisplay") as display_cls,
    ):
        menu = MagicMock()
        menu_cls.return_value = menu
        menu.__enter__.return_value = object()
        display = MagicMock()
        display_cls.return_value = display
        display.__enter__.return_value = MagicMock()
        await nav.navigator_main()
    menu_cls.assert_called_once()
    display_cls.assert_called_once()
    hub_loop.assert_awaited_once()
