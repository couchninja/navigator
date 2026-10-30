from __future__ import annotations

import asyncio

from astropy.time import Time

from gpio.button_menu import ButtonMenu
from navigator.observer_speed import observer_speed_display_lines
from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.simulation_clock import simulation_time

_REFRESH_S = 1.0

PRINT_OBSERVER_SPEED = False


class ObserverSpeedDisplay:
    """Observer speed readout; ``ObserverSpeedLcd`` drives the physical LCD on Linux."""

    def __enter__(self) -> ObserverSpeedDisplay:
        self.show_target(PointingTarget.EARTH_ROTATION, simulation_time())
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def show_target(self, target: PointingTarget, time: Time | None = None) -> None:
        when = simulation_time() if time is None else time
        line1, line2 = observer_speed_display_lines(when, target)
        if PRINT_OBSERVER_SPEED:
            if line2:
                print(f"Observer speed: {line1} — {line2}")
            else:
                print(f"Observer speed: {line1}")


async def run_observer_speed_refresh(display: ObserverSpeedDisplay, buttons: ButtonMenu) -> None:
    while True:
        display.show_target(buttons.selected_button["target"])
        await asyncio.sleep(_REFRESH_S)
