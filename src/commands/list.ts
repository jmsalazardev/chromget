import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { compareVersions, majorOf, isUrlAllowed } from "../lib/versions.js";
import { fetchDatabaseFromGitHub } from "../lib/github.js";
import chromeJson from "../resources/chrome.json" with { type: "json" };
import type { ChromeDatabase, OsTarget } from "../lib/types.js";

interface ListCommandOptions {
  online?: boolean;
  offline?: boolean;
}

/**
 * Returns the best status across allowed mirrors for an OS entry.
 */
function bestMirrorStatus(
  mirrors: string[] | undefined,
  downloads: Record<string, any>,
): "online" | "offline" | "unchecked" | null {
  if (!mirrors || mirrors.length === 0) return null;

  const allowed = mirrors.filter((url) => isUrlAllowed(url));
  if (allowed.length === 0) return null;

  let allOffline = true;
  let hasOnline = false;

  for (const url of allowed) {
    const meta = downloads[url];
    if (meta) {
      if (meta.status === "online") {
        hasOnline = true;
        allOffline = false;
      } else if (meta.status !== "offline") {
        allOffline = false;
      }
    } else {
      allOffline = false;
    }
  }

  if (hasOnline) return "online";
  if (allOffline) return "offline";
  return "unchecked";
}

/**
 * Lists Chrome versions available in chrome.json in a formatted ASCII table.
 */
export async function runList(
  majorsArg: number[],
  options: ListCommandOptions,
): Promise<void> {
  p.intro(pc.bgGreen(pc.black(" chromget list ")));

  const spinner = p.spinner();
  spinner.start("Fetching available Chrome releases from GitHub...");
  let chromeDb: ChromeDatabase;
  try {
    chromeDb = await fetchDatabaseFromGitHub();
    spinner.stop("Successfully synchronized with GitHub Releases.");
  } catch (err: any) {
    spinner.stop("Failed to synchronize with GitHub Releases. Using offline fallback.", 1);
    p.log.warn(pc.yellow(`Reason: ${err.message}`));
    chromeDb = chromeJson as unknown as ChromeDatabase;
  }

  const downloadsPath = path.resolve("chrome-downloads.json");
  let downloads: Record<string, any> = {};
  if (fs.existsSync(downloadsPath)) {
    try {
      downloads = JSON.parse(fs.readFileSync(downloadsPath, "utf8"));
    } catch {
      // ignore
    }
  }

  const byMajor = new Map<number, string[]>();
  for (const ver of Object.keys(chromeDb)) {
    const m = majorOf(ver);
    let list = byMajor.get(m);
    if (!list) {
      list = [];
      byMajor.set(m, list);
    }
    list.push(ver);
  }

  for (const [major, list] of byMajor.entries()) {
    list.sort((a, b) => compareVersions(b, a));
  }

  let majors = Array.from(byMajor.keys()).sort((a, b) => b - a);

  if (majorsArg.length > 0) {
    majors = majors.filter((m) => majorsArg.includes(m));
  }

  if (options.online || options.offline) {
    majors = majors.filter((m) => {
      const patches = byMajor.get(m) || [];
      return patches.some((v) => {
        const targets = chromeDb[v];
        if (!targets) return false;
        return Object.entries(targets).some(([key, value]) => {
          if (key === "releaseDate" || !value) return false;
          const mirrors = value as string[];
          if (!Array.isArray(mirrors)) return false;
          const status = bestMirrorStatus(mirrors, downloads);
          if (options.online && status === "online") return true;
          if (options.offline && status === "offline") return true;
          return false;
        });
      });
    });
  }

  if (majors.length === 0) {
    p.log.warn("No Chrome versions matched the filter criteria.");
    p.outro("Done.");
    return;
  }

  const columns: { label: string; key: string; width: number }[] = [
    { label: "Version", key: "version", width: 8 },
    { label: "Release Date", key: "releaseDate", width: 12 },
    { label: "win_x86", key: "win_x86", width: 16 },
    { label: "win_x64", key: "win_x64", width: 16 },
    { label: "mac_x64", key: "mac_x64", width: 16 },
    { label: "mac_arm64", key: "mac_arm64", width: 16 },
    { label: "linux_x64", key: "linux_x64", width: 16 },
    { label: "linux_rpm", key: "linux_x64_rpm", width: 16 },
  ];

  const pad = (str: string, width: number): string => {
    return str.padEnd(width).slice(0, width);
  };

  const headerLine = columns
    .map((col) => pc.bold(pad(col.label, col.width)))
    .join(" | ");

  const separator = columns
    .map((col) => "─".repeat(col.width))
    .join("─┼─");

  p.log.info("Available versions:");
  console.log(`  ${headerLine}`);
  console.log(`  ${separator}`);

  for (const major of majors) {
    const rowCells: string[] = [];

    const versionCol = columns[0];
    if (versionCol) {
      rowCells.push(pad(String(major), versionCol.width));
    }

    const patches = byMajor.get(major) || [];

    for (let i = 1; i < columns.length; i++) {
      const col = columns[i];
      if (!col) continue;

      if (col.key === "releaseDate") {
        const patchWithDate = patches.find((v) => chromeDb[v]?.releaseDate);
        let dateText = "-";
        if (patchWithDate) {
          const fullDate = chromeDb[patchWithDate]!.releaseDate!;
          dateText = fullDate.split("T")[0] || "-";
        }
        rowCells.push(pc.dim(pad(dateText, col.width)));
        continue;
      }

      const os = col.key;

      const foundAvailablePatch = patches.find((v) => {
        const mirrors = chromeDb[v]?.[os as OsTarget] as string[] | undefined;
        const status = bestMirrorStatus(mirrors, downloads);
        return status === "online" || status === "unchecked";
      });

      let cellText = "";
      let colorFn = (str: string) => str;

      if (foundAvailablePatch) {
        cellText = foundAvailablePatch;
        const mirrors = chromeDb[foundAvailablePatch]![os as OsTarget] as string[];
        const status = bestMirrorStatus(mirrors, downloads);
        colorFn = status === "online" ? pc.green : pc.yellow;
      } else {
        const foundOfflinePatch = patches.find((v) => {
          const mirrors = chromeDb[v]?.[os as OsTarget] as string[] | undefined;
          return bestMirrorStatus(mirrors, downloads) === "offline";
        });

        if (foundOfflinePatch) {
          cellText = foundOfflinePatch;
          colorFn = pc.red;
        } else {
          cellText = "-";
          colorFn = pc.dim;
        }
      }

      rowCells.push(colorFn(pad(cellText, col.width)));
    }

    console.log(`  ${rowCells.join(" | ")}`);
  }

  console.log();
  p.outro(`Listed ${pc.cyan(majors.length)} major versions.`);
}
