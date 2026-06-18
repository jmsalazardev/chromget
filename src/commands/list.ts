import * as p from "@clack/prompts";
import pc from "picocolors";
import { compareVersions, majorOf } from "../lib/versions.js";
import chromeJson from "../resources/chrome.json" with { type: "json" };
import type { ChromeDatabase, ChromeRelease, OsTarget } from "../lib/types.js";

interface ListCommandOptions {
  online?: boolean;
  offline?: boolean;
}

/**
 * Lists Chrome versions available in chrome.json in a formatted ASCII table.
 * Grouped by Major version, showing the latest patch version for each platform.
 */
export async function runList(
  majorsArg: number[],
  options: ListCommandOptions
): Promise<void> {
  p.intro(pc.bgGreen(pc.black(" chromget list ")));

  const chromeDb = chromeJson as unknown as ChromeDatabase;

  // 1. Group available versions by major version: Map<major, versionKeys[]>
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

  // Sort patch versions for each major in descending order
  for (const [major, list] of byMajor.entries()) {
    list.sort((a, b) => compareVersions(b, a));
  }

  // Sort major versions in descending order
  let majors = Array.from(byMajor.keys()).sort((a, b) => b - a);

  // 2. Filter majors if specified via arguments
  if (majorsArg.length > 0) {
    majors = majors.filter((m) => majorsArg.includes(m));
  }

  // 3. Filter by online/offline status if options are enabled
  if (options.online || options.offline) {
    majors = majors.filter((m) => {
      const patches = byMajor.get(m) || [];
      return patches.some((v) => {
        const targets = chromeDb[v];
        if (!targets) return false;
        return Object.entries(targets).some(([key, release]) => {
          if (key === "releaseDate" || !release) return false;
          const r = release as ChromeRelease;
          if (options.online && r.status === "online") return true;
          if (options.offline && r.status === "offline") return true;
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

  // Column definitions with specific layout widths
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

  // Formatting padding helper (applied prior to color coding to prevent width misalignment)
  const pad = (str: string, width: number): string => {
    return str.padEnd(width).slice(0, width);
  };

  // Build header line
  const headerLine = columns
    .map((col) => pc.bold(pad(col.label, col.width)))
    .join(" | ");
  
  // Build separator line
  const separator = columns
    .map((col) => "─".repeat(col.width))
    .join("─┼─");

  p.log.info("Available versions:");
  console.log(`  ${headerLine}`);
  console.log(`  ${separator}`);

  for (const major of majors) {
    const rowCells: string[] = [];
    
    // Add version column (major)
    const versionCol = columns[0];
    if (versionCol) {
      rowCells.push(pad(String(major), versionCol.width));
    }

    const patches = byMajor.get(major) || [];

    // Add target status columns
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

      // 1. Find the newest patch where status is NOT offline
      const foundAvailablePatch = patches.find((v) => {
        const release = chromeDb[v]?.[os as OsTarget];
        return release !== undefined && release.status !== "offline";
      });

      let cellText = "";
      let colorFn = (str: string) => str;

      if (foundAvailablePatch) {
        const release = chromeDb[foundAvailablePatch]![os as OsTarget]!;
        cellText = foundAvailablePatch;
        if (release.status === "online") {
          colorFn = pc.green;
        } else {
          colorFn = pc.yellow; // unchecked
        }
      } else {
        // 2. Find the newest patch where status IS offline
        const foundOfflinePatch = patches.find((v) => {
          const release = chromeDb[v]?.[os as OsTarget];
          return release !== undefined && release.status === "offline";
        });

        if (foundOfflinePatch) {
          cellText = foundOfflinePatch;
          colorFn = pc.red;
        } else {
          // 3. No patch exists for this platform
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
