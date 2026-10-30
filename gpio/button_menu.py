"""In-process target selection; ``ButtonMenuGpio`` drives the physical panel on Linux."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from gpio.button_config import (
    BUTTONS,
    CLOCK_UNSYNC_BUTTON_INDEX,
    DEFAULT_BUTTON_INDEX,
    HUB_CALIBRATE_BUTTON_INDEX,
    HUB_SEARCH_BUTTON_INDEX,
    ButtonConfig,
    ButtonData,
    HubLinkPhase,
    PanelStatus,
)
from simulate.astronomy.constants import PointingTarget

__all__ = [
    "BUTTONS",
    "ButtonConfig",
    "ButtonData",
    "ButtonMenu",
    "CLOCK_UNSYNC_BUTTON_INDEX",
    "DEFAULT_BUTTON_INDEX",
    "HUB_CALIBRATE_BUTTON_INDEX",
    "HUB_SEARCH_BUTTON_INDEX",
    "HubLinkPhase",
    "PanelStatus",
]


class ButtonMenu:
    """Target selection API shared by the web UI and optional GPIO hardware."""

    def __init__(self, buttons: tuple[ButtonConfig, ...] = BUTTONS) -> None:
        self._buttons = buttons
        self._mode_indices = [0] * len(buttons)
        self._selected_index = DEFAULT_BUTTON_INDEX
        self._wake = asyncio.Event()
        self._inputs_enabled = False

    def __enter__(self) -> ButtonMenu:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def set_inputs_enabled(self, enabled: bool) -> None:
        self._inputs_enabled = enabled

    @property
    def inputs_enabled(self) -> bool:
        return self._inputs_enabled

    @asynccontextmanager
    async def panel_status(self) -> AsyncIterator[PanelStatus]:
        yield PanelStatus()

    @property
    def selected_button(self) -> ButtonData:
        index = self._selected_index
        button = self._buttons[index]
        mode = button["modes"][self._mode_indices[index]]
        return {
            "button_pin": button["button_pin"],
            "led_pin": button["led_pin"],
            "target": mode["target"],
            "color": mode["color"],
        }

    def reset(self) -> None:
        self._selected_index = DEFAULT_BUTTON_INDEX
        self._mode_indices = [0] * len(self._buttons)

    def cycle_pointing_target(self) -> None:
        targets = list(PointingTarget)
        current = self.selected_button["target"]
        next_target = targets[(targets.index(current) + 1) % len(targets)]
        self.select_target(next_target)

    def select_target(self, target: PointingTarget) -> None:
        for index, button in enumerate(self._buttons):
            for mode_index, mode in enumerate(button["modes"]):
                if mode["target"] == target:
                    self._selected_index = index
                    self._mode_indices[index] = mode_index
                    self._wake.set()
                    return
        raise ValueError(f"No button mode for {target!r}")

    async def wait_for_selection(self, *, timeout_s: float) -> None:
        deadline = time.monotonic() + timeout_s
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            if self._wake.is_set():
                self._wake.clear()
                return
            await asyncio.sleep(min(remaining, 0.2))

    @asynccontextmanager
    async def blinking_selected(self) -> AsyncIterator[None]:
        yield
