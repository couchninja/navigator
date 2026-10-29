from navigator.observer_speed import observer_speed_km_h, observer_speed_lcd_lines
from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.utils.ephemeris import current_time


def test_lcd_lines_show_speed_for_earth_rotation() -> None:
    time = current_time()
    line1, line2 = observer_speed_lcd_lines(time, PointingTarget.EARTH_ROTATION)
    assert line1 == "Earth rotation"
    speed = observer_speed_km_h(time, PointingTarget.EARTH_ROTATION)
    assert speed is not None
    assert line2 == f"{speed:.2f} km/h"


def test_lcd_lines_blank_speed_for_sun() -> None:
    time = current_time()
    line1, line2 = observer_speed_lcd_lines(time, PointingTarget.SUN)
    assert line1 == "Sun"
    assert line2 == ""
