"""Power down panel GPIO outputs (LCD and button LEDs) after service stop."""

from gpio.button_menu_gpio import power_off_button_leds
from gpio.observer_speed_lcd import power_off_lcd


def shutdown_panel_gpio() -> None:
    power_off_lcd()
    power_off_button_leds()


if __name__ == "__main__":
    shutdown_panel_gpio()
