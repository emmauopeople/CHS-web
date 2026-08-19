export function localDateAtInstant(instant: string, timeZone: string): string {
  const value = new Date(instant);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Invalid synchronization timestamp');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
