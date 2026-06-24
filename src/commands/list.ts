import * as p from "@clack/prompts";
import pc from "picocolors";
import { compareVersions, majorOf } from "../lib/versions.js";
import { fetchDatabaseFromGitHub } from "../lib/github.js";
import type { ChromeDatabase, OsTarget } from "../lib/types.js";



/**
 * Lists Chrome versions available in chrome.json in a formatted ASCII table.
 */
export async function runList(
  majorsArg: number[],
): Promise<void> {
  p.intro(pc.bgGreen(pc.black(" chromget list ")));

  const spinner = p.spinner();
  spinner.start("Fetching available Chrome releases from GitHub...");
  let chromeDb: ChromeDatabase;
  try {
    chromeDb = await fetchDatabaseFromGitHub();
    spinner.stop("Successfully synchronized with GitHub Releases.");
  } catch (err: any) {
    spinner.stop("Failed to synchronize with GitHub Releases.", 1);
    p.log.error(pc.red(`Fatal Error: ${err.message}`));
    throw err;
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
        return mirrors && mirrors.length > 0;
      });

      let cellText = "";
      let colorFn = (str: string) => str;

      if (foundAvailablePatch) {
        cellText = foundAvailablePatch;
        colorFn = pc.green;
      } else {
        cellText = "-";
        colorFn = pc.dim;
      }

      rowCells.push(colorFn(pad(cellText, col.width)));
    }

    console.log(`  ${rowCells.join(" | ")}`);
  }

  console.log();
  p.outro(`Listed ${pc.cyan(majors.length)} major versions.`);
}
