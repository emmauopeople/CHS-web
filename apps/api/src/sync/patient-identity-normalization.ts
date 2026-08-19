export function normalizeIdentityName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function normalizePhone(value: string | null): string | null {
  if (value === null) return null;

  let digits = value.replace(/\D/gu, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^6\d{8}$/.test(digits)) digits = `237${digits}`;
  return digits.length >= 7 ? digits : null;
}
