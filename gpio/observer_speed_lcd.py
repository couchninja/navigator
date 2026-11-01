from __future__ import annotations

from astropy.time import Time

from gpio.hd44780_i2c import Hd44780I2c
from gpio.observer_speed_display import ObserverSpeedDisplay
from navigator.observer_speed import observer_speed_display_lines
from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.simulation_clock import simulation_time

_DEFAULT_BUS = 1
_LCD_ADDRESS = 0x27


def lcd_i2c_address() -> int:
    return _LCD_ADDRESS


class ObserverSpeedLcd(ObserverSpeedDisplay):
    def __init__(
        self,
        *,
        bus: int = _DEFAULT_BUS,
        address: int | None = None,
    ) -> None:
        super().__init__()
        addr = lcd_i2c_address() if address is None else address
        self._lcd = Hd44780I2c(bus=bus, address=addr)

    def __enter__(self) -> ObserverSpeedLcd:
        self._lcd.init()
        self.show_target(PointingTarget.EARTH_ROTATION, simulation_time())
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop_lcd_updates()
        self._lcd.close()

    def show_target(self, target: PointingTarget, time: Time | None = None) -> None:
        if not self._updates_enabled:
            return
        when = simulation_time() if time is None else time
        line1, line2 = observer_speed_display_lines(when, target)
        self._lcd.write_line(0, line1)
        self._lcd.write_line(1, line2)
