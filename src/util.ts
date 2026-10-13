/** Shared small utilities. */

export function now(): string {
  return new Date().toISOString();
}

export function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === "number" ? Math.floor(value) : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function truncate(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  return { text: text.slice(0, maxLen) + `\n...[truncated ${text.length - maxLen} chars]`, truncated: true };
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}
