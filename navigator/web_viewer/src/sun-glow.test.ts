import { describe, expect, it } from "vitest";

import { sunGlowDiameterAu } from "./sun-glow";

describe("sunGlowDiameterAu", () => {
  it("scales with sun radius", () => {
    expect(sunGlowDiameterAu(0.01)).toBeCloseTo(0.16);
  });
});
