"""Exercise the HW-061 LCD on the Pi (requires I2C wiring)."""

import time

from gpio.observer_speed_lcd import ObserverSpeedLcd
from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.utils.ephemeris import current_time

TARGETS = (
    PointingTarget.EARTH_ROTATION,
    PointingTarget.SUN_ORBIT,
    PointingTarget.MILKY_WAY_ORBIT,
    PointingTarget.CMB_DIPOLE,
    PointingTarget.SUN,
)


def main() -> None:
    when = current_time()
    with ObserverSpeedLcd() as lcd:
        for target in TARGETS:
            lcd.show_target(target, when)
            time.sleep(2.0)


main()
