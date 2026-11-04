// A custom snooze time on the night the clocks change, in a time zone that has one. Node takes a new TZ as soon as it
// is set, so it is set before any Date is made in this file.
import { afterAll, describe, expect, it, vi } from "vitest";
import { customUntil } from "./snooze";

vi.stubEnv("TZ", "America/Chicago");
afterAll(() => vi.unstubAllEnvs());

describe("customUntil across a clock change", () => {
  const before = new Date(2027, 2, 13, 12).getTime();

  it("refuses a time the clocks skip, rather than moving it", () => {
    expect(new Date(2027, 2, 14, 2, 30).getHours()).toBe(3);
    expect(customUntil({ at: "2027-03-14T02:30" }, before)).toBe("That time is skipped when the clocks change.");
  });

  it("takes the times either side of it", () => {
    expect(customUntil({ at: "2027-03-14T01:59" }, before)).toBe(new Date(2027, 2, 14, 1, 59).getTime());
    expect(customUntil({ at: "2027-03-14T03:00" }, before)).toBe(new Date(2027, 2, 14, 3, 0).getTime());
  });
});
