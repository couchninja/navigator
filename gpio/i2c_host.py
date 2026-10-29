from __future__ import annotations

import shutil


def require_i2c_tools() -> None:
    if shutil.which("i2cdetect") is None:
        raise RuntimeError(
            "i2c-tools is not installed; install with: sudo apt install i2c-tools"
            ' and add your user to the i2c group: sudo usermod -aG i2c "$USER" (then log out and back in)'
        )
