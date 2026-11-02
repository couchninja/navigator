import { describe, expect, it } from "vitest";

import { opacityFadeOutAboveThreshold } from "./constellation-sky";

describe("opacityFadeOutAboveThreshold", () => {
  it("is 1 at or below the fade start", () => {
    expect(opacityFadeOutAboveThreshold(0.05, 0.1, 0.3)).toBe(1);
    expect(opacityFadeOutAboveThreshold(0.1, 0.1, 0.3)).toBe(1);
  });

  it("is 0 at or beyond fade start plus span", () => {
    expect(opacityFadeOutAboveThreshold(0.4, 0.1, 0.3)).toBe(0);
    expect(opacityFadeOutAboveThreshold(1, 0.1, 0.3)).toBe(0);
  });

  it("smoothsteps between fade start and end", () => {
    const mid = opacityFadeOutAboveThreshold(0.25, 0.1, 0.3);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});
