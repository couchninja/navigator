import { EarthSunViewer } from "./earth-sun-viewer";
import type { SceneSnapshot } from "./scene-types";

async function unregisterServiceWorkers(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    return false;
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  if (registrations.length === 0) {
    return false;
  }
  await Promise.all(registrations.map((registration) => registration.unregister()));
  return true;
}

function navigatorAppShellPresent(): boolean {
  return document.querySelector(".app-shell") !== null;
}

const SCENE_POLL_REALTIME_MS = 10_000;
const SCENE_POLL_FAST_MS = 1000 / 30;

type TimeScaleStatus = {
  preset: string | null;
  time_iso?: string;
  time_scaling?: number;
};

type NavigatorWebStatus = {
  target: string;
  time_scale: TimeScaleStatus;
  speed_km_h: number | null;
};

function scenePollIntervalMs(preset: string | null): number {
  return preset === "realtime" ? SCENE_POLL_REALTIME_MS : SCENE_POLL_FAST_MS;
}

function mountStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
    .earth-sun-viewer {
      position: relative;
      width: 100%;
      flex: 1 1 auto;
      min-height: 0;
      height: 100%;
      border-radius: 12px;
      overflow: hidden;
      background: #0a0e12;
    }
    .earth-sun-viewer-canvas {
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 240px;
    }
    .earth-sun-viewer-canvas canvas {
      display: block;
      width: 100% !important;
      height: 100% !important;
    }
    .earth-sun-viewer-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 20;
    }
    .earth-sun-viewer-caption {
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(15, 20, 25, 0.72);
      color: #e8eef4;
      font: 600 13px system-ui, sans-serif;
    }
    .earth-sun-viewer-fps {
      position: absolute;
      top: 8px;
      left: 8px;
      color: rgba(255, 255, 255, 0.78);
      font: 600 13px system-ui, sans-serif;
    }
    .earth-sun-viewer-speed {
      display: none;
      position: absolute;
      bottom: max(12px, env(safe-area-inset-bottom));
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 14px;
      border-radius: 8px;
      background: rgba(15, 20, 25, 0.72);
      color: #e8eef4;
      font: 400 22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .earth-sun-viewer.viewer-fullscreen-ui .earth-sun-viewer-fps,
    .earth-sun-viewer.viewer-fullscreen-ui .earth-sun-viewer-caption {
      display: none;
    }
    .earth-sun-viewer.viewer-fullscreen-ui .earth-sun-viewer-speed {
      display: block;
    }
  `;
  document.head.appendChild(style);
}

type SceneFetchOptions = {
  includeEphemerisOrbitPaths: boolean;
};

async function fetchScene(options: SceneFetchOptions): Promise<SceneSnapshot> {
  const ephemeris = options.includeEphemerisOrbitPaths ? "1" : "0";
  const response = await fetch(`/api/scene?ephemeris_orbits=${ephemeris}`);
  if (!response.ok) {
    throw new Error(`scene fetch failed: ${response.status}`);
  }
  return response.json() as Promise<SceneSnapshot>;
}

function navigatorStatusFromDetail(detail: unknown): NavigatorWebStatus | null {
  if (detail === null || typeof detail !== "object") {
    return null;
  }
  const record = detail as Record<string, unknown>;
  const target = record.target;
  if (typeof target !== "string") {
    return null;
  }
  const timeScaleRaw = record.time_scale;
  if (timeScaleRaw === null || typeof timeScaleRaw !== "object" || !("preset" in timeScaleRaw)) {
    return null;
  }
  const timeScale = timeScaleRaw as TimeScaleStatus;
  const preset = timeScale.preset;
  if (preset !== null && typeof preset !== "string") {
    return null;
  }
  const timeIso = timeScale.time_iso;
  if (timeIso !== undefined && typeof timeIso !== "string") {
    return null;
  }
  const timeScaling = timeScale.time_scaling;
  if (timeScaling !== undefined && typeof timeScaling !== "number") {
    return null;
  }
  const speedRaw = record.speed_km_h;
  if (speedRaw !== undefined && speedRaw !== null && typeof speedRaw !== "number") {
    return null;
  }
  const speed_km_h = speedRaw === undefined ? null : speedRaw;
  return { target, time_scale: { preset, time_iso: timeIso, time_scaling: timeScaling }, speed_km_h };
}

function viewerFullscreenUiActive(): boolean {
  return document.querySelector(".app-shell")?.classList.contains("viewer-fullscreen") ?? false;
}

function speedKmHFromDetail(detail: unknown): number | null {
  if (detail === null || typeof detail !== "object") {
    return null;
  }
  const speedRaw = (detail as Record<string, unknown>).speed_km_h;
  if (speedRaw === undefined || speedRaw === null) {
    return null;
  }
  if (typeof speedRaw !== "number") {
    return null;
  }
  return speedRaw;
}

export function startEarthSunViewer(mount: HTMLElement): EarthSunViewer {
  mountStyles();
  const viewer = new EarthSunViewer(mount);
  viewer.setFullscreenUiMode(viewerFullscreenUiActive());
  viewer.setGeometryPollIntervalMs(SCENE_POLL_REALTIME_MS);

  window.addEventListener("navigator-viewer-fullscreen", (event) => {
    const active = (event as CustomEvent<{ active?: boolean }>).detail?.active === true;
    viewer.setFullscreenUiMode(active);
  });

  let scenePollMs = SCENE_POLL_REALTIME_MS;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollGeneration = 0;
  let inFlight = false;
  let scenePollingActive = false;
  let lastPointingTarget: string | null = null;
  let lastTimeScalePreset: string | null = null;
  const sidebarLegacyOrbits = document.getElementById("legacy-orbit-lines-control");
  let includeEphemerisOrbitPaths =
    sidebarLegacyOrbits instanceof HTMLInputElement ? sidebarLegacyOrbits.checked : false;

  const stopScenePollLoop = (): void => {
    pollGeneration += 1;
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const scheduleNextScenePoll = (): void => {
    const generation = pollGeneration;
    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      if (generation !== pollGeneration) {
        return;
      }
      void pollScene().finally(() => {
        if (generation !== pollGeneration) {
          return;
        }
        scheduleNextScenePoll();
      });
    }, scenePollMs);
  };

  const applyScenePollMs = (nextMs: number): void => {
    if (nextMs === scenePollMs) {
      return;
    }
    scenePollMs = nextMs;
    viewer.setGeometryPollIntervalMs(nextMs);
    if (scenePollingActive) {
      stopScenePollLoop();
      scheduleNextScenePoll();
    }
  };

  const pollScene = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const snapshot = await fetchScene({ includeEphemerisOrbitPaths });
      viewer.applySnapshot(snapshot);
    } catch {
      // Keep the last good frame; the status panel still reports navigator state.
    } finally {
      inFlight = false;
    }
  };

  viewer.setSceneRefreshHook(() => {
    void pollScene();
  });

  const beginScenePolling = (): void => {
    if (scenePollingActive) {
      return;
    }
    scenePollingActive = true;
    void pollScene().finally(() => {
      scheduleNextScenePoll();
    });
  };

  const applyNavigatorStatus = (detail: unknown): void => {
    viewer.updateSpeedOverlay(speedKmHFromDetail(detail));
    const status = navigatorStatusFromDetail(detail);
    if (status === null) {
      return;
    }
    const preset = status.time_scale.preset;
    applyScenePollMs(scenePollIntervalMs(preset));
    const navigatorButtonInput =
      (lastPointingTarget !== null && lastPointingTarget !== status.target) ||
      (lastTimeScalePreset !== null && lastTimeScalePreset !== preset);
    if (navigatorButtonInput) {
      viewer.releaseUserCameraControl();
    }
    if (lastPointingTarget !== null && lastPointingTarget !== status.target) {
      void pollScene();
    }
    lastPointingTarget = status.target;
    lastTimeScalePreset = preset;
    viewer.applyNavigatorStatus({
      target: status.target,
      timeIso: status.time_scale.time_iso ?? null,
      timeScaling: status.time_scale.time_scaling ?? 1,
      speedKmH: status.speed_km_h,
    });
    beginScenePolling();
  };

  window.addEventListener("navigator-status", (event) => {
    applyNavigatorStatus((event as CustomEvent).detail);
  });
  applyNavigatorStatus((window as Window & { __navigatorLastStatus?: unknown }).__navigatorLastStatus);

  if (sidebarLegacyOrbits instanceof HTMLInputElement) {
    sidebarLegacyOrbits.addEventListener("change", () => {
      includeEphemerisOrbitPaths = sidebarLegacyOrbits.checked;
      viewer.setLegacySegmentOrbitsVisible(sidebarLegacyOrbits.checked);
      void pollScene();
    });
    viewer.setLegacySegmentOrbitsVisible(sidebarLegacyOrbits.checked);
  }

  const sidebarParametricOrbits = document.getElementById("parametric-orbit-lines-control");
  if (sidebarParametricOrbits instanceof HTMLInputElement) {
    sidebarParametricOrbits.addEventListener("change", () => {
      viewer.setParametricOrbitsVisible(sidebarParametricOrbits.checked);
    });
    viewer.setParametricOrbitsVisible(sidebarParametricOrbits.checked);
  }

  const sidebarIdleCamera = document.getElementById("idle-camera-infinity-control");
  if (sidebarIdleCamera instanceof HTMLInputElement) {
    sidebarIdleCamera.addEventListener("change", () => {
      viewer.setIdleCameraInfinityEnabled(sidebarIdleCamera.checked);
    });
    viewer.setIdleCameraInfinityEnabled(sidebarIdleCamera.checked);
  }

  window.dispatchEvent(new CustomEvent("earth-sun-viewer-ready", { detail: viewer }));

  return viewer;
}

let earthSunViewerMounted = false;

function mountEarthSunViewerWhenLaidOut(): void {
  if (earthSunViewerMounted) {
    return;
  }
  const mount = document.getElementById("viewer-root");
  if (!mount) {
    return;
  }
  earthSunViewerMounted = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      startEarthSunViewer(mount);
    });
  });
}

async function mountEarthSunViewerWhenReady(): Promise<void> {
  if (await unregisterServiceWorkers()) {
    location.reload();
    return;
  }
  if (!navigatorAppShellPresent()) {
    const path = window.location.pathname;
    if (path !== "/" && path !== "") {
      location.replace("/");
      return;
    }
    const retried = sessionStorage.getItem("navigator-shell-retry");
    if (retried === null) {
      sessionStorage.setItem("navigator-shell-retry", "1");
      location.replace(`/?navigator_shell=${Date.now()}`);
      return;
    }
    return;
  }
  sessionStorage.removeItem("navigator-shell-retry");

  const lastStatus = (window as Window & { __navigatorLastStatus?: unknown }).__navigatorLastStatus;
  if (lastStatus !== undefined) {
    mountEarthSunViewerWhenLaidOut();
    return;
  }
  window.addEventListener(
    "navigator-status",
    () => {
      mountEarthSunViewerWhenLaidOut();
    },
    { once: true },
  );
  window.setTimeout(() => {
    mountEarthSunViewerWhenLaidOut();
  }, 2500);
}

void mountEarthSunViewerWhenReady();
