export const OS_TARGETS = [
  "win_x86",
  "win_x64",
  "mac_x64",
  "mac_arm64",
  "linux_x64",
  "linux_x64_rpm",
] as const;
export type OsTarget = (typeof OS_TARGETS)[number];

export interface ChromeRelease {
  url: string;
  status?: "online" | "offline";
  checkedAt?: string;
  size?: number | null;
  error?: string;
}

export interface ChromeDatabase {
  [version: string]: {
    releaseDate?: string;
    win_x86?: ChromeRelease;
    win_x64?: ChromeRelease;
    mac_x64?: ChromeRelease;
    mac_arm64?: ChromeRelease;
    linux_x64?: ChromeRelease;
    linux_x64_rpm?: ChromeRelease;
    [os: string]: any;
  };
}

export interface PickInfo {
  version: string;
  url: string;
}

export interface MajorPlan {
  major: number;
  picks: {
    [os in OsTarget]?: PickInfo;
  };
}

export interface DownloadResult {
  status: "downloaded" | "resumed" | "skipped" | "failed";
  size: number;
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



