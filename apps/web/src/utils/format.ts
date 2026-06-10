export function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatFullDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

export function shortId(value?: string | null): string {
  if (!value) return "-";
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
    } catch {
      return raw;
    }
  }
  return raw;
}

export function normalizeAuthToken(value: string): string {
  let next = value.trim();
  if (next.startsWith("AUTH_TOKEN=")) {
    next = next.slice("AUTH_TOKEN=".length).trim();
  }
  if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1).trim();
  }
  return next;
}
