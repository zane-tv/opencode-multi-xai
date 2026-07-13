import { describe, expect, it } from "vitest";
import {
  inferPlanNameFromLimit,
  planNameFromTier,
  formatPlanLimit,
} from "../lib/request/plan.js";

describe("plan labels", () => {
  it("maps JWT tier 5 as Heavy (observed SuperGrok Heavy OAuth)", () => {
    expect(planNameFromTier(5)).toBe("SuperGrok Heavy");
    expect(planNameFromTier(2)).toBe("SuperGrok Lite");
    expect(planNameFromTier(3)).toBe("SuperGrok");
  });

  it("uses monthly limit and never downgrades Heavy", () => {
    expect(inferPlanNameFromLimit(150_000)).toBe("SuperGrok Heavy");
    expect(planNameFromTier(5, 150_000)).toBe("SuperGrok Heavy");
    // limit Heavy wins over a lower tier label
    expect(planNameFromTier(3, 150_000)).toBe("SuperGrok Heavy");
    expect(inferPlanNameFromLimit(40_000)).toBe("SuperGrok Lite");
    expect(inferPlanNameFromLimit(100_000)).toBe("SuperGrok");
  });

  it("formats limits compactly", () => {
    expect(formatPlanLimit(150000)).toBe("150k");
    expect(formatPlanLimit(5241)).toBe("5k");
  });
});
