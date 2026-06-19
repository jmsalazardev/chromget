import type { ChromeDatabase, OsTarget, MajorPlan, PickInfo } from "./types.js";

/**
 * Parses a version string into an array of integers.
 */
export function parseVersion(v: string): number[] {
  return v.split(".").map((n) => parseInt(n, 10) || 0);
}

/**
 * Compares two version strings. Returns a positive number if a > b,
 * a negative number if a < b, and 0 if they are equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Extracts the major version number from a version string.
 */
export function majorOf(v: string): number {
  return parseInt(v.split(".")[0] ?? "0", 10);
}

/**
 * Domains whose URLs are excluded from the download plan.
 * These hosts are known to serve redirect/landing pages instead of direct binaries.
 */
export const BLOCKED_DOMAINS = [
  "google-chrome.en.uptodown.com",
  "uptodown.com",
 ] as const;

/**
 * Returns true if the URL's hostname is NOT in the blocked domains list.
 */
export function isUrlAllowed(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return !BLOCKED_DOMAINS.some(
      (blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`),
    );
  } catch {
    return false;
  }
}

/**
 * Filters and returns allowed mirrors.
 */
export function rankMirrors(mirrors: string[]): string[] {
  return mirrors.filter((url) => isUrlAllowed(url));
}

/**
 * Adds a mirror to an array, avoiding duplicate URLs.
 */
export function addMirror(
  existing: string[] | undefined,
  url: string,
): string[] {
  if (!existing || existing.length === 0) {
    return [url];
  }
  if (existing.includes(url)) {
    return existing;
  }
  return [...existing, url];
}

/**
 * Builds the download plan based on available versions, target majors, and operating systems.
 * Returns all versions within each major that have at least one usable mirror, sorted descendingly.
 */
export function buildPlan(
  versions: ChromeDatabase,
  onlyMajors: number[],
  osTargets: readonly OsTarget[],
): MajorPlan[] {
  const byMajor = new Map<number, string[]>();

  for (const ver of Object.keys(versions)) {
    const m = majorOf(ver);
    let list = byMajor.get(m);
    if (!list) {
      list = [];
      byMajor.set(m, list);
    }
    list.push(ver);
  }

  const majors = [...byMajor.keys()].sort((a, b) => b - a);
  const plan: MajorPlan[] = [];

  for (const major of majors) {
    if (onlyMajors.length > 0 && !onlyMajors.includes(major)) {
      continue;
    }

    const verList = byMajor.get(major)!.sort((a, b) => compareVersions(b, a));
    const picks: MajorPlan["picks"] = {};

    for (const os of osTargets) {
      const candidates: PickInfo[] = [];
      for (const v of verList) {
        const mirrors = versions[v]?.[os] as string[] | undefined;
        if (mirrors && Array.isArray(mirrors)) {
          const ranked = rankMirrors(mirrors);
          if (ranked.length > 0) {
            candidates.push({ version: v, mirrors: ranked });
          }
        }
      }
      if (candidates.length > 0) {
        picks[os] = candidates;
      }
    }

    plan.push({ major, picks });
  }

  return plan;
}
