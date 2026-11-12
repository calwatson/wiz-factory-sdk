export function dueDateFrom(now: Date, days: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addLabel(labels: string[], label: string): string[] {
  if (!label || labels.includes(label)) return [...labels];
  return [...labels, label];
}
