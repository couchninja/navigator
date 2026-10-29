from __future__ import annotations

import asyncio
import contextlib
import sys
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from typing import TYPE_CHECKING

from pybricks.parameters import Port

from gpio.button_config import ButtonData, PanelStatus
from gpio.button_menu_host import HostButtonMenu

if TYPE_CHECKING:
    from gpio.button_menu import ButtonMenu
    from gpio.button_menu_host import HostButtonMenu
    from gpio.observer_speed_lcd import ObserverSpeedLcd

    ButtonTargetSource = ButtonMenu | HostButtonMenu
from navigator.system_clock import clock_is_synchronized
from navigator.web_ui import LogBuffer, begin_navigator_session, capture_stdout, run_web_ui
from navigator.web_viewer_build import build_web_viewer_if_ready
from pybricks_client import ColorDistanceSensor, Motor, MotorStalledError, MoveHub
from pybricks_client.ble import RECOVERABLE_ERRORS, format_error
from simulate.astronomy.constants import PointingTarget
from simulate.astronomy.simulation_clock import simulation_time
from simulate.astronomy.utils.ephemeris import (
    current_time,
    observer_surface_vector_and_euler_angles_for_target,
)
from simulate.astronomy.utils.iss_tle import set_celestrak_fetch_allowed
from simulate.astronomy.utils.remote_data import refresh_astronomy_downloads

INACTIVITY_REFRESH_S = 10.0
CLOCK_WAIT_POLL_S = 5.0
RECONNECT_DELAY_S = 2.0
PAN_DUTY_LIMIT = 150
TILT_DUTY_LIMIT = 200
MIN_TARGET_ANGLE_DELTA = 1
# Make sure this matches the ports in pybricks_hub/thin_ble_hub.py and the script is on the brick
EXTERNAL_MOTOR_PORT = Port.D
SENSOR_PORT = Port.C
LCD_ENABLED = True

_last_target_angles: dict[str, float] = {}


def clamp_yaw(yaw: float) -> float:
    return min(yaw % 360, 340)


def clamp_pitch(pitch: float) -> float:
    return max(min(pitch, 90), -90)


def get_motors(hub: MoveHub) -> tuple[Motor, Motor]:
    return hub.motor(Port.A), hub.motor(EXTERNAL_MOTOR_PORT)


def clear_last_target(motor: Motor) -> None:
    _last_target_angles.pop(motor.port.name, None)


async def calibrate_motors(hub: MoveHub) -> None:
    motor_pan, motor_tilt = get_motors(hub)
    _last_target_angles.clear()
    # duty_limit 50 for non-geared base
    pan_angle = await motor_pan.run_until_stalled(-150, duty_limit=PAN_DUTY_LIMIT)
    print(f"Pan motor stalled at angle {pan_angle:.1f} degrees.")
    await motor_pan.reset_angle(0)
    clear_last_target(motor_pan)
    await run_target_or_warn(motor_pan, PAN_DUTY_LIMIT, 180, "Pan")

    tilt_angle = await motor_tilt.run_until_stalled(-100, duty_limit=TILT_DUTY_LIMIT)
    print(f"Tilt motor stalled at angle {tilt_angle:.1f} degrees.")
    await motor_tilt.reset_angle(-85)
    clear_last_target(motor_tilt)


async def run_target_or_warn(motor: Motor, speed: float, target_angle: float, label: str) -> None:
    port_name = motor.port.name
    last_target = _last_target_angles.get(port_name)
    if last_target is not None and abs(target_angle - last_target) < MIN_TARGET_ANGLE_DELTA:
        print(f"{label} motor: skipped (within {MIN_TARGET_ANGLE_DELTA:.1f}° of last target)")
        return

    _last_target_angles[port_name] = target_angle
    try:
        await motor.run_target(speed, target_angle=target_angle)
    except MotorStalledError:
        actual = await motor.angle()
        print(f"Warning: {label} motor stalled at {actual:.1f}° (target {target_angle:.1f}°)")
        return

    print(f"{label} motor: moving to {target_angle:.1f}°")


def pointing_would_move(target: PointingTarget) -> bool:
    time = simulation_time()
    _surface, (yaw, pitch, _roll), _speed = observer_surface_vector_and_euler_angles_for_target(time, target)
    yaw = clamp_yaw(yaw)
    pitch = clamp_pitch(pitch)
    pan_last = _last_target_angles.get(Port.A.name)
    tilt_last = _last_target_angles.get(EXTERNAL_MOTOR_PORT.name)
    if pan_last is None or abs(yaw - pan_last) >= MIN_TARGET_ANGLE_DELTA:
        return True
    return tilt_last is None or abs(pitch - tilt_last) >= MIN_TARGET_ANGLE_DELTA


async def point_at_target(hub: MoveHub, target: PointingTarget) -> None:
    print(f"Pointing at target: {target.label}")
    motor_pan, motor_tilt = get_motors(hub)

    time = simulation_time()
    _surface, (yaw, pitch, _roll), _speed = observer_surface_vector_and_euler_angles_for_target(time, target)

    print(f"Raw yaw: {yaw:.1f} degrees. Pitch: {pitch:.1f} degrees.")
    yaw = clamp_yaw(yaw)
    pitch = clamp_pitch(pitch)
    print(f"Clamped yaw: {yaw:.1f} degrees. Pitch: {pitch:.1f} degrees.")

    await run_target_or_warn(motor_pan, PAN_DUTY_LIMIT, yaw, "Pan")
    print(f"Pan motor angle: {(await motor_pan.angle()):.1f} degrees.")

    await run_target_or_warn(motor_tilt, TILT_DUTY_LIMIT, pitch, "Tilt")
    print(f"Tilt motor angle: {(await motor_tilt.angle()):.1f} degrees.")


@asynccontextmanager
async def connected_hub(
    program: str | None,
    *,
    panel_status: PanelStatus | None = None,
) -> AsyncIterator[MoveHub]:
    async with AsyncExitStack() as stack:
        while True:
            if panel_status is not None:
                panel_status.clock_synchronized = clock_is_synchronized()
            try:
                hub = await stack.enter_async_context(MoveHub.connect(program=program, retries=1))
                break
            except RECOVERABLE_ERRORS as exc:
                print(f"Connection failed ({format_error(exc)}); searching again...")
                await asyncio.sleep(RECONNECT_DELAY_S)
        yield hub


async def point_selected(hub: MoveHub, sensor: ColorDistanceSensor, button: ButtonData) -> None:
    print(f"Selected button: {button}")
    await sensor.light.on(button["color"])
    await point_at_target(hub, button["target"])


def resume_after_clock_sync() -> None:
    """Re-arm time-dependent state once the clock jumped to the correct time."""
    print(f"Clock synchronized (system time {current_time().iso} UTC); resuming pointing.")
    refresh_astronomy_downloads(allow_network=True)
    _last_target_angles.clear()


async def wait_for_clock_sync_panel(buttons: ButtonTargetSource) -> None:
    async with buttons.panel_status() as status:
        status.hub = "ready"
        while not clock_is_synchronized():
            status.clock_synchronized = False
            await asyncio.sleep(CLOCK_WAIT_POLL_S)
        status.clock_synchronized = True


async def connect_and_calibrate(hub_stack: AsyncExitStack, buttons: ButtonTargetSource, program: str | None) -> MoveHub:
    async with buttons.panel_status() as status:
        hub: MoveHub | None = None
        calibrated = False
        while True:
            status.clock_synchronized = clock_is_synchronized()
            if hub is None:
                status.hub = "disconnected"
                try:
                    hub = await hub_stack.enter_async_context(connected_hub(program, panel_status=status))
                except RECOVERABLE_ERRORS as exc:
                    print(f"Connection failed ({format_error(exc)}); searching again...")
                    await asyncio.sleep(RECONNECT_DELAY_S)
                    continue
                print("Hub connected.")
            if not calibrated:
                status.hub = "calibrating"
                await calibrate_motors(hub)
                calibrated = True
            status.hub = "ready"
            while not clock_is_synchronized():
                status.clock_synchronized = False
                await asyncio.sleep(CLOCK_WAIT_POLL_S)
            status.clock_synchronized = True
            refresh_astronomy_downloads(allow_network=True)
            await asyncio.sleep(0)
            return hub


async def run_selection_loop(hub: MoveHub, buttons: ButtonTargetSource) -> None:
    """Point at the selected target, then wait for the next press or a refresh.

    Pointing is suspended while the clock is unsynchronized, since every angle is
    derived from the current time. The hub stays connected and the loop keeps
    polling, so pointing resumes on its own once a time source is reached.
    """
    sensor = hub.color_distance_sensor(SENSOR_PORT)
    clock_ready = True
    try:
        while True:
            if not clock_is_synchronized():
                if clock_ready:
                    clock_ready = False
                    set_celestrak_fetch_allowed(False)
                    print(
                        f"Clock not synchronized (system time {current_time().iso} UTC); "
                        "pointing suspended until the time is correct."
                    )
                buttons.set_inputs_enabled(False)
                await wait_for_clock_sync_panel(buttons)
                continue
            if not clock_ready:
                clock_ready = True
                buttons.set_inputs_enabled(True)
                buttons.reset()
                resume_after_clock_sync()

            button = buttons.selected_button
            if pointing_would_move(button["target"]):
                async with buttons.blinking_selected():
                    await point_selected(hub, sensor, button)
            await buttons.wait_for_selection(timeout_s=INACTIVITY_REFRESH_S)
    finally:
        with suppress(*RECOVERABLE_ERRORS):
            await sensor.light.off()


def gpio_available() -> bool:
    return sys.platform != "darwin"


async def run_navigator_loop(
    buttons: ButtonTargetSource,
    log_buffer: LogBuffer,
    *,
    upload_program: bool,
    lcd: ObserverSpeedLcd | None = None,
) -> None:
    from gpio.observer_speed_lcd import ObserverSpeedLcd, run_lcd_refresh

    refresh_astronomy_downloads(allow_network=False)
    program = "pybricks_hub/thin_ble_hub.py" if upload_program else None

    async with AsyncExitStack() as outer_stack:
        await outer_stack.enter_async_context(run_web_ui(buttons, log_buffer))
        lcd_task: asyncio.Task[None] | None = None
        if isinstance(lcd, ObserverSpeedLcd):
            lcd_task = asyncio.create_task(run_lcd_refresh(lcd, buttons))
        try:
            while True:
                buttons.reset()
                buttons.set_inputs_enabled(False)
                try:
                    async with AsyncExitStack() as hub_stack:
                        hub = await connect_and_calibrate(hub_stack, buttons, program)
                        buttons.reset()
                        buttons.set_inputs_enabled(True)
                        await run_selection_loop(hub, buttons)
                except RECOVERABLE_ERRORS as exc:
                    print(f"Hub lost ({format_error(exc)}); searching again...")
                    await asyncio.sleep(RECONNECT_DELAY_S)
        finally:
            if lcd_task is not None:
                lcd_task.cancel()
                with suppress(asyncio.CancelledError):
                    await lcd_task


async def navigator_main(upload_program: bool = False) -> None:
    build_web_viewer_if_ready()
    begin_navigator_session()
    print("Navigator main")
    log_buffer = LogBuffer()

    if gpio_available():
        from gpio.button_menu import ButtonMenu
        from gpio.i2c_host import require_i2c_tools
        from gpio.observer_speed_lcd import ObserverSpeedLcd

        if LCD_ENABLED:
            require_i2c_tools()
        lcd_ctx: contextlib.AbstractContextManager[ObserverSpeedLcd | None] = (
            ObserverSpeedLcd() if LCD_ENABLED else contextlib.nullcontext(None)
        )
        with ButtonMenu() as buttons, lcd_ctx as lcd, capture_stdout(log_buffer):
            await run_navigator_loop(buttons, log_buffer, upload_program=upload_program, lcd=lcd)
        return

    print("Navigator (GPIO disabled on macOS; using web UI for target selection)")
    with HostButtonMenu() as buttons, capture_stdout(log_buffer):
        await run_navigator_loop(buttons, log_buffer, upload_program=upload_program)


if __name__ == "__main__":
    # asyncio.run(navigator_main(upload_program=True))
    asyncio.run(navigator_main(upload_program=False))
