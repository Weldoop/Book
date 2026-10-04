const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parseLocal(value: string): number {
  const m = LOCAL.exec(value);
  if (!m) throw new Error(`Invalid local datetime: ${value}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

export function formatLocal(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

export function addMinutes(value: string, minutes: number): string {
  return formatLocal(parseLocal(value) + minutes * 60_000);
}

export function diffMinutes(later: string, earlier: string): number {
  return Math.round((parseLocal(later) - parseLocal(earlier)) / 60_000);
}

export function humanTime(value: string): string {
  const d = new Date(parseLocal(value));
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm}`;
}

export function shortTime(value: string): string {
  const d = new Date(parseLocal(value));
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${hh}:${mm}`;
}
