import { describe, expect, it } from "vitest";
import { addDays, isIsoDate, periodStart, relativeAnchors, startOfWeek, todayIn } from "../src/dates.ts";

describe("dates", () => {
  it("computes today in the user's timezone", () => {
    const instant = new Date("2026-10-28T02:30:00Z");
    expect(todayIn("America/New_York", instant)).toBe("2026-10-27");
    expect(todayIn("Asia/Tokyo", instant)).toBe("2026-10-28");
  });

  it("starts weeks on Monday", () => {
    expect(startOfWeek("2026-10-28")).toBe("2026-10-26"); // Wednesday
    expect(startOfWeek("2026-11-01")).toBe("2026-10-26"); // Sunday
    expect(startOfWeek("2026-10-26")).toBe("2026-10-26"); // Monday
  });

  it("normalizes dates to period starts", () => {
    expect(periodStart("day", "2026-10-28")).toBe("2026-10-28");
    expect(periodStart("month", "2026-10-28")).toBe("2026-10-01");
    expect(periodStart("year", "2026-10-28")).toBe("2026-01-01");
    expect(periodStart("someday", "2026-10-28")).toBeNull();
  });

  it("gives relative anchors across month and year boundaries", () => {
    const a = relativeAnchors("2026-12-31");
    expect(a.tomorrow).toBe("2027-01-01");
    expect(a.next_week).toBe("2027-01-04");
    expect(a.next_month).toBe("2027-01-01");
    expect(a.next_year).toBe("2027-01-01");
    expect(relativeAnchors("2026-01-31").next_month).toBe("2026-02-01");
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-1-1")).toBe(false);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
