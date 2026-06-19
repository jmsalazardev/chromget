export const OS_TARGETS = [
  "win_x86",
  "win_x64",
  "mac_x64",
  "mac_arm64",
  "linux_x64",
  "linux_x64_rpm",
] as const;
export type OsTarget = (typeof OS_TARGETS)[number];

/**
 * The database of all Chrome versions keyed by full version string.
 * Each OS target maps directly to an array of mirror URL strings.
 */
export interface ChromeDatabase {
  [version: string]: {
    releaseDate?: string;
    win_x86?: string[];
    win_x64?: string[];
    mac_x64?: string[];
    mac_arm64?: string[];
    linux_x64?: string[];
    linux_x64_rpm?: string[];
    [os: string]: any;
  };
}

/**
 * Information about a selected version for download.
 * Includes an ordered list of mirror URL strings to try.
 */
export interface PickInfo {
  version: string;
  mirrors: string[];
}

export interface MajorPlan {
  major: number;
  picks: {
    [os in OsTarget]?: PickInfo[];
  };
}

export interface DownloadResult {
  status: "downloaded" | "resumed" | "skipped" | "failed";
  size: number;
  mirrorUrl?: string;
}

export interface FailureInfo {
  major: number;
  os: string;
  version: string;
  error: string;
}

export interface DownloadStats {
  downloaded: number;
  resumed: number;
  skipped: number;
  failed: number;
  missing: number;
}

export interface DownloadOptions {
  outputDir: string;
  osTargets: OsTarget[];
  continueOnError: boolean;
  onlyMajors: number[];
  timeoutMs: number;
}
