/**
 * Formats a byte number into a human-readable string (e.g. KB, MB, GB).
 */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
