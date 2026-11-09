/**
 * Five-field cron, read in UTC: minute hour day-of-month month day-of-week. Each field takes a
 * star, a number, a range a-b, a list a,b and a step after a slash (a star or range, then /n).
 * Day-of-week runs 0 to 6 from
 * Sunday, and 7 is Sunday too. As in classic cron, when both day fields are restricted a day
 * matches either.
 */
export interface Cron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Whether day-of-month and day-of-week were both given, not *. */
  eitherDay: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function field(text: string, { name, min, max }: (typeof FIELDS)[number]): Set<number> | string {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return `${name}: cannot read "${part}"`;
    const from = match[1] === "*" ? min : Number(match[2]);
    const to = match[1] === "*" ? max : match[3] !== undefined ? Number(match[3]) : from;
    const step = match[4] !== undefined ? Number(match[4]) : 1;
    if (from < min || to > max || from > to) return `${name}: ${part} is outside ${min}-${max}`;
    if (step < 1) return `${name}: the step in ${part} must be at least 1`;
    const end = match[4] !== undefined && match[3] === undefined && match[1] !== "*" ? max : to;
    for (let value = from; value <= end; value += step) out.add(value);
  }
  return out;
}

/** The parsed expression, or a message saying what is wrong with it. */
export function parseCron(expression: string): Cron | string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    return `Expected 5 fields (minute hour day month weekday), got ${parts.length}`;
  const sets: Set<number>[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    const parsed = field(parts[index] as string, spec);
    if (typeof parsed === "string") return parsed;
    sets.push(parsed);
  }
  const [minutes, hours, days, months, weekdays] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    eitherDay: parts[2] !== "*" && parts[4] !== "*",
  };
}

/** Whether the minute `at` falls in (seconds ignored), in UTC. */
export function cronMatches(cron: Cron, at: Date): boolean {
  if (!cron.minutes.has(at.getUTCMinutes()) || !cron.hours.has(at.getUTCHours())) return false;
  if (!cron.months.has(at.getUTCMonth() + 1)) return false;
  const day = cron.days.has(at.getUTCDate());
  const weekday = cron.weekdays.has(at.getUTCDay());
  return cron.eitherDay ? day || weekday : day && weekday;
}

/** Missed minutes further back than this are not looked at. */
const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * The minutes in (after, until] the expression fires at, oldest first, at most `limit` of them,
 * so a scheduler that was down for a while starts each missed run once and not hundreds.
 */
export function cronTimes(cron: Cron, after: Date, until: Date, limit = 1): Date[] {
  const out: Date[] = [];
  const from = Math.max(after.getTime(), until.getTime() - MAX_LOOKBACK_MS);
  const start = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let t = start; t <= until.getTime() && out.length < limit; t += 60_000) {
    const at = new Date(t);
    if (cronMatches(cron, at)) out.push(at);
  }
  return out;
}
