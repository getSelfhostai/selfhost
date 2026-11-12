import { ADVISOR_DAYS_OF_WEEK, type AdvisorDayOfWeek, type NotifyCadence } from "@selfhost/schema";

const DAY_MS = 86_400_000;

/**
 * The digest window `now` is in: from the last send time at or before now (each day at
 * `hour` UTC, or Mondays at `hour` for weekly) to the next one. undefined for off.
 */
export function digestWindow(
  cadence: NotifyCadence,
  now: Date,
  hour: number,
): { start: Date; key: string } | undefined {
  if (cadence === "off") return undefined;
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let start = day + hour * 3_600_000;
  if (start > now.getTime()) start -= DAY_MS;
  if (cadence === "weekly") {
    // Back to the Monday of the window's day: getUTCDay is 0 on Sunday.
    const weekday = (new Date(start).getUTCDay() + 6) % 7;
    start -= weekday * DAY_MS;
  }
  const at = new Date(start);
  return { start: at, key: `${cadence}:${at.toISOString()}` };
}

/** The spend digest's window: daily at `hour` UTC. */
export function spendDigestWindow(now: Date, hour: number): { start: Date; key: string } {
  const window = digestWindow("daily", now, hour);
  if (!window) throw new Error("unreachable: a daily window always exists");
  return { start: window.start, key: `spend:${window.start.toISOString()}` };
}

const WEEKDAYS: readonly AdvisorDayOfWeek[] = ADVISOR_DAYS_OF_WEEK;
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The wall clock in a timezone at an instant: date, hour, minute, second and weekday (0 Monday). */
function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
    weekday: SHORT_DAYS.indexOf(part("weekday")),
  };
}

/**
 * The instant a wall-clock time in a timezone happens. A time a clock change skips is taken an
 * hour later; one it repeats, the first time.
 */
function instantOf(
  date: { year: number; month: number; day: number },
  hour: number,
  timeZone: string,
): Date {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const wall = wallClock(new Date(guess), timeZone);
    const shown = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
    );
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return new Date(guess);
}

/**
 * The advisor window `now` is in: from the last `day` at `hour` in `timeZone` at or before now to
 * the next. The note sent then covers the 7 days before start.
 */
export function advisorWindow(
  now: Date,
  schedule: { day: AdvisorDayOfWeek; hour: number; timeZone: string },
): { start: Date; key: string } {
  const wall = wallClock(now, schedule.timeZone);
  const back = (wall.weekday - WEEKDAYS.indexOf(schedule.day) + 7) % 7;
  const at = (days: number) => {
    const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day - days));
    return instantOf(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
      schedule.hour,
      schedule.timeZone,
    );
  };
  let start = at(back);
  if (start > now) start = at(back + 7);
  return { start, key: `advisor:${start.toISOString()}` };
}
