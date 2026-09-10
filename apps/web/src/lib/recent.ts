/**
 * "Recent" for the space overview: the lists this person opened most recently,
 * kept per browser in localStorage. It's a convenience, not a record, so it
 * never reaches the server and failing to read it just yields an empty list.
 */
const KEY = "pm:recent";
const MAX = 20;

export interface RecentItem {
  listId: string;
  listName: string;
  spaceId: string;
  spaceName: string;
  at: number;
}

export function readRecent(spaceId?: string): RecentItem[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "[]") as RecentItem[];
    return spaceId ? all.filter((r) => r.spaceId === spaceId) : all;
  } catch {
    return [];
  }
}

export function recordRecent(item: Omit<RecentItem, "at">) {
  try {
    const rest = readRecent().filter((r) => r.listId !== item.listId);
    localStorage.setItem(KEY, JSON.stringify([{ ...item, at: Date.now() }, ...rest].slice(0, MAX)));
  } catch {
    // Storage unavailable (private mode, quota) — recent just stays empty.
  }
}
