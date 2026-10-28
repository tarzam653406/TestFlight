// Calendar math on plain "YYYY-MM-DD" strings. All arithmetic is done in UTC so
// the user's timezone only matters when deciding what "today" is.

export type Horizon = "day" | "week" | "month" | "year" | "someday";
export const HORIZONS: readonly Horizon[] = ["day", "week", "month", "year", "someday"];

const DAY_MS = 86_400_000;

export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return toIso(parse(s)) === s;
}

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIso(new Date(parse(iso).getTime() + days * DAY_MS));
}

export function weekday(iso: string): string {
  return parse(iso).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

/** Weeks start on Monday. */
export function startOfWeek(iso: string): string {
  const dow = (parse(iso).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(iso, -dow);
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function startOfYear(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`;
}

/**
 * Normalizes any date inside a period to the period's first day, which is how
 * tasks are stored. "someday" tasks have no period.
 */
export function periodStart(horizon: Horizon, iso: string): string | null {
  switch (horizon) {
    case "day":
      return iso;
    case "week":
      return startOfWeek(iso);
    case "month":
      return startOfMonth(iso);
    case "year":
      return startOfYear(iso);
    case "someday":
      return null;
  }
}

/** The period starts that contain `iso`, one per dated horizon. */
export function periodsContaining(iso: string): Record<Exclude<Horizon, "someday">, string> {
  return {
    day: iso,
    week: startOfWeek(iso),
    month: startOfMonth(iso),
    year: startOfYear(iso),
  };
}

/** Reference dates the planner can use when it reads "next week", "next month", ... */
export function relativeAnchors(today: string): Record<string, string> {
  const thisMonth = startOfMonth(today);
  const nextMonth = startOfMonth(addDays(thisMonth, 32));
  const nextYear = `${Number(today.slice(0, 4)) + 1}-01-01`;
  return {
    today,
    tomorrow: addDays(today, 1),
    this_week: startOfWeek(today),
    next_week: addDays(startOfWeek(today), 7),
    this_month: thisMonth,
    next_month: nextMonth,
    this_year: startOfYear(today),
    next_year: nextYear,
  };
}
