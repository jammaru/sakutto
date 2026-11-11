export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Unique size labels for copy such as “573 MB / 1.81 GB”. */
export function formatByteSizeList(sizes: readonly number[]): string {
  const labels: string[] = [];
  for (const size of sizes) {
    const label = formatByteSize(size);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? labels.join(' / ') : formatByteSize(0);
}
