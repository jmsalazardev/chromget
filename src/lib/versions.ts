import type { ChromeDatabase, OsTarget, MajorPlan } from "./types.js";

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
 * Builds the download plan based on available versions, target majors, and operating systems.
 * It selects the latest version within each major that contains the package for a specific OS.
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

  // Sort majors in descending order
  const majors = [...byMajor.keys()].sort((a, b) => b - a);

  const plan: MajorPlan[] = [];

  for (const major of majors) {
    if (onlyMajors.length > 0 && !onlyMajors.includes(major)) {
      continue;
    }

    // Sort patches from newest to oldest
    const verList = byMajor.get(major)!.sort((a, b) => compareVersions(b, a));

    const picks: MajorPlan["picks"] = {};

    for (const os of osTargets) {
      // Find the first patch (newest) that has a URL for this OS
      const found = verList.find((v) => {
        const verObj = versions[v];
        return verObj && verObj[os] !== undefined;
      });

      if (found) {
        const url = versions[found]![os]!.url;
        picks[os] = { version: found, url };
      }
    }

    plan.push({ major, picks });
  }

  return plan;
}
