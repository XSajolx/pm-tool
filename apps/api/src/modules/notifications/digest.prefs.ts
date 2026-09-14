/** Row 76: one summary instead of twenty pings. */
export interface DigestPrefs {
  frequency: "off" | "daily" | "weekly";
  /** Local hour (0-23) to send at. */
  hour: number;
  /** 0 = Sunday ... 6 = Saturday; weekly only. */
  weekday: number;
  inApp: boolean;
  email: boolean;
}
export const DEFAULT_DIGEST: DigestPrefs = { frequency: "off", hour: 8, weekday: 1, inApp: true, email: true };

export function resolveDigest(stored: Partial<DigestPrefs> | null | undefined): DigestPrefs {
  return { ...DEFAULT_DIGEST, ...(stored ?? {}) };
}
