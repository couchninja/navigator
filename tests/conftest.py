import sys

collect_ignore: list[str] = []
"""Button menu tests need gpiod, which pixi installs only on Linux."""
if sys.platform != "linux":
    collect_ignore.append("test_button_menu_gpio.py")
