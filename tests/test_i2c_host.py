from unittest.mock import patch

import pytest

from gpio.i2c_host import require_i2c_tools


def test_require_i2c_tools_passes_when_i2cdetect_on_path() -> None:
    with patch("gpio.i2c_host.shutil.which", return_value="/usr/bin/i2cdetect"):
        require_i2c_tools()


def test_require_i2c_tools_raises_when_missing() -> None:
    with (
        patch("gpio.i2c_host.shutil.which", return_value=None),
        pytest.raises(RuntimeError, match="i2c-tools"),
    ):
        require_i2c_tools()
