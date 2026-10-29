from __future__ import annotations

import time

from smbus2 import SMBus

_LCD_COLS = 16
_LCD_ROWS = 2

# PCF8574 backpack on HW-061 (typical wiring).
_MASK_RS = 0x01
_MASK_EN = 0x04
_MASK_BACKLIGHT = 0x08

_CMD_CLEAR = 0x01
_CMD_HOME = 0x02
_CMD_ENTRY_MODE = 0x06
_CMD_DISPLAY_ON = 0x0C
_CMD_FUNCTION_SET = 0x28


class Hd44780I2c:
    """16×2 HD44780 LCD with PCF8574 I2C backpack (e.g. HW-061)."""

    def __init__(
        self,
        *,
        bus: int = 1,
        address: int = 0x27,
        cols: int = _LCD_COLS,
        rows: int = _LCD_ROWS,
    ) -> None:
        self._bus_number = bus
        self._address = address
        self._cols = cols
        self._rows = rows
        self._backlight = True
        self._bus = SMBus(bus)

    def close(self) -> None:
        self._bus.close()

    def init(self) -> None:
        time.sleep(0.05)
        self._write4bits(0x03 << 4)
        time.sleep(0.0045)
        self._write4bits(0x03 << 4)
        time.sleep(0.0045)
        self._write4bits(0x03 << 4)
        time.sleep(0.00015)
        self._write4bits(0x02 << 4)
        self._command(_CMD_FUNCTION_SET)
        self._command(_CMD_DISPLAY_ON)
        self._command(_CMD_CLEAR)
        time.sleep(0.002)
        self._command(_CMD_ENTRY_MODE)

    def clear(self) -> None:
        self._command(_CMD_CLEAR)
        time.sleep(0.002)

    def set_backlight(self, on: bool) -> None:
        self._backlight = on
        self._write4bits(0)

    def write_line(self, row: int, text: str) -> None:
        if row < 0 or row >= self._rows:
            raise ValueError(f"row must be 0..{self._rows - 1}, got {row}")
        self._set_cursor(row, 0)
        padded = text[: self._cols].ljust(self._cols)
        for char in padded:
            self._write_char(ord(char))

    def _set_cursor(self, row: int, col: int) -> None:
        row_offsets = (0x00, 0x40, 0x14, 0x54)
        self._command(0x80 | (row_offsets[row] + col))

    def _command(self, value: int) -> None:
        self._write(value, mode=0)

    def _write_char(self, value: int) -> None:
        self._write(value, mode=_MASK_RS)

    def _write(self, value: int, *, mode: int) -> None:
        self._write4bits(value & 0xF0, mode)
        self._write4bits((value << 4) & 0xF0, mode)

    def _write4bits(self, data: int, mode: int = 0) -> None:
        bits = data | mode
        if self._backlight:
            bits |= _MASK_BACKLIGHT
        self._bus.write_byte(self._address, bits | _MASK_EN)
        self._bus.write_byte(self._address, bits & ~_MASK_EN)
