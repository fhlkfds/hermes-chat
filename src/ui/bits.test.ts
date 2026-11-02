import { afterEach, expect, it, vi } from "vitest";
import { storedTime } from "./bits";

afterEach(() => vi.unstubAllEnvs());

it("shows a stored time as a date and time in the owner's time zone", () => {
  const at = Date.UTC(2026, 0, 15, 23, 30);
  // UTC+13 in January: already the next day.
  vi.stubEnv("TZ", "Pacific/Auckland");
  expect(storedTime(at)).toMatch(/16/);
  expect(storedTime(at)).toContain("12:30");
  expect(storedTime(at)).toContain("2026");
  // UTC-6.
  vi.stubEnv("TZ", "America/Chicago");
  expect(storedTime(at)).toMatch(/15/);
  expect(storedTime(at)).toMatch(/\b(5|17):30/);
});
