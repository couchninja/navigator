from unittest.mock import patch

from gpio.observer_speed_display import ObserverSpeedDisplay
from navigator.observer_speed import observer_speed_display_lines, observer_speed_km_h
from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.utils.ephemeris import current_time


def test_display_lines_show_speed_for_earth_rotation() -> None:
    time = current_time()
    line1, line2 = observer_speed_display_lines(time, PointingTarget.EARTH_ROTATION)
    assert line1 == "Earth rotation"
    speed = observer_speed_km_h(time, PointingTarget.EARTH_ROTATION)
    assert speed is not None
    assert line2 == f"{speed:.2f} km/h"


def test_display_lines_blank_speed_for_sun() -> None:
    time = current_time()
    line1, line2 = observer_speed_display_lines(time, PointingTarget.SUN)
    assert line1 == "Sun"
    assert line2 == ""


def test_stop_lcd_updates_blocks_show_target() -> None:
    display = ObserverSpeedDisplay()
    with patch("gpio.observer_speed_display.observer_speed_display_lines") as lines:
        display.stop_lcd_updates()
        display.show_target(PointingTarget.SUN, current_time())
    lines.assert_not_called()
