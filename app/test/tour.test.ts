import { describe, expect, it } from "vitest";
import { TOUR_STEPS } from "../src/lib/tour";

describe("tour config", () => {
  it("has the 10 route-aware steps from the spec, in order", () => {
    expect(TOUR_STEPS).toHaveLength(10);
    expect(TOUR_STEPS.map((s) => s.route)).toEqual(["/", "/", "/", "/", "/play", "/play", "/play", "/lab", "/verify", "/proof"]);
  });
  it("every step targets a data-tour anchor and has copy", () => {
    for (const s of TOUR_STEPS) {
      expect(s.selector).toMatch(/^\[data-tour=[a-z]+\]$/);
      expect(s.title.length).toBeGreaterThan(5);
      expect(s.text.length).toBeGreaterThan(20);
    }
  });
});
