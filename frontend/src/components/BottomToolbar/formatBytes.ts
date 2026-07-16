export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  const fixed = n >= 100 || idx === 0 ? 0 : 1;
  return `${n.toFixed(fixed)} ${units[idx]}`;
}
