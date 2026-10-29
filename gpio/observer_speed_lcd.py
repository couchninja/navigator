from __future__ import annotations

import asyncio

from astropy.time import Time

from gpio.button_menu import ButtonMenu
from gpio.button_menu_host import HostButtonMenu
from gpio.hd44780_i2c import Hd44780I2c
from navigator.observer_speed import observer_speed_lcd_lines
from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.simulation_clock import simulation_time

_DEFAULT_BUS = 1
_LCD_ADDRESS = 0x27
_REFRESH_S = 1.0



def lcd_i2c_address() -> int:
    return _LCD_ADDRESS


class ObserverSpeedLcd:
    def __init__(
        self,
        *,
        bus: int = _DEFAULT_BUS,
        address: int | None = None,
    ) -> None:
        addr = lcd_i2c_address() if address is None else address
        self._lcd = Hd44780I2c(bus=bus, address=addr)

    def __enter__(self) -> ObserverSpeedLcd:
        self._lcd.init()
        self.show_target(PointingTarget.EARTH_ROTATION, simulation_time())
        return self

    def __exit__(self, *exc: object) -> None:
        self._lcd.clear()
        self._lcd.set_backlight(False)
        self._lcd.close()

    def show_target(self, target: PointingTarget, time: Time | None = None) -> None:
        when = simulation_time() if time is None else time
        line1, line2 = observer_speed_lcd_lines(when, target)
        self._lcd.write_line(0, line1)
        self._lcd.write_line(1, line2)


async def run_lcd_refresh(lcd: ObserverSpeedLcd, buttons: ButtonMenu | HostButtonMenu) -> None:
    while True:
        lcd.show_target(buttons.selected_button["target"])
        await asyncio.sleep(_REFRESH_S)
