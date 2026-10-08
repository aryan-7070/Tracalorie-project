/** Shared date/number helpers for the tracker. Pure functions, no React. */

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const toYYYYMMDD = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Shift a YYYY-MM-DD key by whole days. Parsed as local calendar parts, not as a timestamp. */
export function addDays(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return toYYYYMMDD(new Date(y, m - 1, d + delta));
}

/** "Today" / "Yesterday" / "Mon, 12 Jan" for the day navigator. */
export function dayLabel(dateKey) {
  const today = toYYYYMMDD(new Date());
  if (dateKey === today) return 'Today';
  if (dateKey === addDays(today, -1)) return 'Yesterday';

  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
