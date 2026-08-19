export type LocalMeasurementInstant =
  | Readonly<{ kind: 'EXACT'; instant: string }>
  | Readonly<{ kind: 'AMBIGUOUS' }>
  | Readonly<{ kind: 'INVALID' }>;

type LocalParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}>;

function parseLocalDateTime(
  localDate: string,
  localTime: string,
): LocalParts | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(
      `${localDate}T${localTime}`,
    );
  if (!match) return null;

  const parts: LocalParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const normalized = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute
  ) {
    return null;
  }
  return parts;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function partsAt(formatter: Intl.DateTimeFormat, instant: number): LocalParts {
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
  };
}

function sameParts(left: LocalParts, right: LocalParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

export function localMeasurementTimeToInstant(
  localDate: string,
  localTime: string,
  timeZone: string,
): LocalMeasurementInstant {
  const requested = parseLocalDateTime(localDate, localTime);
  if (!requested) return { kind: 'INVALID' };

  const formatter = formatterFor(timeZone);
  const naiveInstant = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
  );
  const sampleOffsets = [-48, -24, 0, 24, 48].map(
    (hours) => naiveInstant + hours * 60 * 60 * 1000,
  );
  const offsets = new Set(
    sampleOffsets.map((sample) => {
      const local = partsAt(formatter, sample);
      const representedAsUtc = Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour,
        local.minute,
      );
      return representedAsUtc - sample;
    }),
  );
  const candidates = new Set<number>();
  for (const offset of offsets) {
    const candidate = naiveInstant - offset;
    if (sameParts(partsAt(formatter, candidate), requested)) {
      candidates.add(candidate);
    }
  }

  if (candidates.size === 0) return { kind: 'INVALID' };
  if (candidates.size > 1) return { kind: 'AMBIGUOUS' };
  return {
    kind: 'EXACT',
    instant: new Date([...candidates][0]!).toISOString(),
  };
}
