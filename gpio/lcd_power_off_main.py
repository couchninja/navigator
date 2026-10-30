"""Turn off the observer-speed LCD (systemd ExecStop / manual use)."""

from gpio.observer_speed_lcd import power_off_lcd

if __name__ == "__main__":
    power_off_lcd()
