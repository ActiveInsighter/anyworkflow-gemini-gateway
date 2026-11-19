/**
 * Pure zero-dependency 5-field cron parser and IANA timezone next-run calculator.
 * Compatible with Cloudflare Workers (no Node-specific dependencies).
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

function parseField(raw: string, min: number, max: number, allowSevenAsZero = false): { values: Set<number>; wildcard: boolean } {
  const token = raw.trim();
  const wildcard = token === '*';
  const values = new Set<number>();

  for (const part of token.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Invalid cron field: ${raw}`);

    const [rangePart, stepPart] = trimmed.split('/');
    if (trimmed.split('/').length > 2) throw new Error(`Invalid cron step: ${trimmed}`);

    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step value: ${trimmed}`);

    let start = min;
    let end = max;

    if (rangePart && rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-');
        start = Number.parseInt(a ?? '', 10);
        end = Number.parseInt(b ?? '', 10);
      } else {
        start = Number.parseInt(rangePart, 10);
        end = start;
      }
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < min || end > max) {
      throw new Error(`Cron value out of range [${min}-${max}]: ${trimmed}`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(allowSevenAsZero && v === 7 ? 0 : v);
    }
  }

  return { values, wildcard };
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Expected 5-field cron expression, got ${parts.length}`);
  }
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minParsed = parseField(m, 0, 59);
  const hourParsed = parseField(h, 0, 23);
  const domParsed = parseField(dom, 1, 31);
  const monParsed = parseField(mon, 1, 12);
  const dowParsed = parseField(dow, 0, 7, true);

  return {
    minutes: minParsed.values,
    hours: hourParsed.values,
    daysOfMonth: domParsed.values,
    months: monParsed.values,
    daysOfWeek: dowParsed.values,
    domWildcard: domParsed.wildcard,
    dowWildcard: dowParsed.wildcard,
  };
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getZonedParts(epochMs: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    lookup[p.type] = p.value;
  }
  const rawHour = Number.parseInt(lookup.hour ?? '0', 10);
  return {
    year: Number.parseInt(lookup.year ?? '1970', 10),
    month: Number.parseInt(lookup.month ?? '1', 10),
    day: Number.parseInt(lookup.day ?? '1', 10),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number.parseInt(lookup.minute ?? '0', 10),
    dayOfWeek: WEEKDAY_MAP[lookup.weekday ?? 'Sun'] ?? 0,
  };
}

export function validateTimeZone(timeZone: string): string {
  const tz = timeZone.trim() || 'Asia/Shanghai';
  // Throws RangeError if invalid IANA timezone
  new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
  return tz;
}

export function nextCronRun(expression: string, timeZone = 'Asia/Shanghai', afterMs = Date.now()): string {
  const cron = parseCron(expression);
  const tz = validateTimeZone(timeZone);

  // Start checking from the next whole minute
  let cursor = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  // Search up to 366 days ahead (527,040 minutes)
  const limit = 366 * 24 * 60;

  for (let i = 0; i < limit; i++) {
    const z = getZonedParts(cursor, tz);
    if (!cron.months.has(z.month)) {
      cursor += 60_000;
      continue;
    }
    const domMatch = cron.daysOfMonth.has(z.day);
    const dowMatch = cron.daysOfWeek.has(z.dayOfWeek);
    const dayMatches =
      cron.domWildcard && cron.dowWildcard
        ? true
        : cron.domWildcard
          ? dowMatch
          : cron.dowWildcard
            ? domMatch
            : domMatch || dowMatch;

    if (dayMatches && cron.hours.has(z.hour) && cron.minutes.has(z.minute)) {
      return new Date(cursor).toISOString();
    }
    cursor += 60_000;
  }

  throw new Error(`No matching run time found within 366 days for cron "${expression}"`);
}
