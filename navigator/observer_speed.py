from __future__ import annotations

from astropy import units as u
from astropy.time import Time

from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.utils.ephemeris import observer_surface_vector_and_euler_angles_for_target

# Sky/body targets point at a direction; velocity targets show observer speed (km/h).
_BODY_TARGETS = frozenset(
    {
        PointingTarget.SUN,
        PointingTarget.MOON,
        PointingTarget.MILKY_WAY_CENTER,
        PointingTarget.ISS,
    }
)


def observer_speed_km_h(time: Time, target: PointingTarget) -> float | None:
    _surface, _euler, speed_au_s = observer_surface_vector_and_euler_angles_for_target(time, target)
    if target in _BODY_TARGETS:
        return None
    speed_km_s = speed_au_s * (1 * u.au).to_value(u.km)
    return float(speed_km_s * 3600.0)


_LCD_COLS = 16


def observer_speed_lcd_lines(time: Time, target: PointingTarget) -> tuple[str, str]:
    line1 = target.label[:_LCD_COLS]
    speed_km_h = observer_speed_km_h(time, target)
    if speed_km_h is None:
        return line1, ""
    return line1, f"{speed_km_h:.2f} km/h"[:_LCD_COLS]
