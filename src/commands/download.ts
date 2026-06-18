import path from "node:path";
import fs from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import cliProgress from "cli-progress";
import { buildPlan } from "../lib/versions.js";
import { downloadFile } from "../lib/downloader.js";
import { fmtBytes } from "../lib/format.js";
import { checkUrl } from "../lib/http.js";
import { unpackCrxFile } from "../lib/crx.js";
import type {
  DownloadStats,
  FailureInfo,
  ChromeDatabase,
  OsTarget,
} from "../lib/types.js";
import { cancel } from "./prompts.js";
import chromeJson from "../resources/chrome.json" with { type: "json" };

export interface DownloadCommandOptions {
  output?: string;
  os?: string[];
  failFast?: boolean;
  timeout?: string;
  dryRun?: boolean;
}

/**
 * Executes the download workflow for target Chrome major versions and operating systems.
 */
export async function runDownload(
  majorsArg: number[],
  cmdOptions: DownloadCommandOptions,
): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" chromget download ")));

  // Resolve options
  const outputDir = path.resolve(cmdOptions.output || "chrome-downloads");
  const failFast = !!cmdOptions.failFast;
  const dryRun = !!cmdOptions.dryRun;
  const timeoutMs = cmdOptions.timeout
    ? parseInt(cmdOptions.timeout, 10)
    : 60_000;

  // OS Targets filtering
  let osTargets: OsTarget[] = [
    "win_x86",
    "win_x64",
    "mac_x64",
    "mac_arm64",
    "linux_x64",
    "linux_x64_rpm",
  ];
  if (cmdOptions.os && cmdOptions.os.length > 0) {
    const filtered = cmdOptions.os
      .flatMap((o) => o.split(","))
      .map((o) => o.trim())
      .filter((o) => osTargets.includes(o as OsTarget)) as OsTarget[];
    if (filtered.length > 0) {
      osTargets = filtered;
    }
  }

  // Interactive prompts if majors argument is empty
  let onlyMajors = majorsArg;
  if (onlyMajors.length === 0) {
    const response = await p.text({
      message:
        "Which major versions do you want to download? (space separated numbers, leave empty for all)",
      placeholder: "e.g., 148 147",
      defaultValue: "",
    });

    if (p.isCancel(response)) {
      return cancel();
    }

    const val = (response ?? "").trim();
    if (val) {
      onlyMajors = val
        .split(/\s+/)
        .map(Number)
        .filter((n) => !isNaN(n));
    }
  }

  // Load Chrome versions from local JSON resource
  const versions = chromeJson as unknown as ChromeDatabase;

  // Build the download plan
  const plan = buildPlan(versions, onlyMajors, osTargets);
  if (plan.length === 0) {
    p.log.warn("No major versions matched the parameters.");
    p.outro("Done.");
    return;
  }

  if (dryRun) {
    p.log.info("Running in dry-run mode: verifying URL availability...");
  } else {
    p.log.info(`Output directory: ${pc.cyan(outputDir)}`);
  }
  p.log.info(
    `Majors to process: ${pc.bold(plan.map((p) => p.major).join(", "))}`,
  );

  const stats: DownloadStats = {
    downloaded: 0,
    resumed: 0,
    skipped: 0,
    failed: 0,
    missing: 0,
  };
  const failures: FailureInfo[] = [];

  for (const { major, picks } of plan) {
    p.log.message(`\n${pc.bold(pc.bgMagenta(pc.black(` Chrome ${major} `)))}`);
    for (const os of osTargets) {
      const pick = picks[os];
      if (!pick) {
        p.log.step(
          `  [${os.padEnd(10)}] ${pc.yellow("not available in major " + major)}`,
        );
        stats.missing++;
        continue;
      }

      const ext = path.extname(new URL(pick.url).pathname);
      
      const parts = os.split("_");
      const osName = parts[0] ?? os;
      const archName = parts[1] ?? "x64";

      const isCrx = ext === ".crx3";
      const finalExt = isCrx ? ".zip" : ext;

      const filename = `chrome_${pick.version}_${osName}_${archName}${finalExt}`;
      const dest = path.join(outputDir, filename);
      const downloadDest = isCrx
        ? path.join(
            outputDir,
            `chrome_${pick.version}_${osName}_${archName}.crx3`,
          )
        : dest;

      // Skip download if the final file (.zip, .exe, .deb etc.) already exists
      if (fs.existsSync(dest)) {
        p.log.success(
          `      ${pc.green("✓")} already downloaded (${fmtBytes(fs.statSync(dest).size)})`,
        );
        stats.skipped++;
        continue;
      }

      if (dryRun) {
        const checkSpinner = p.spinner();
        checkSpinner.start(`Checking [${os.padEnd(10)}] ${pick.version}...`);
        const online = await checkUrl(pick.url, timeoutMs);
        if (online) {
          checkSpinner.stop(
            `${pc.green("✓")} [${os.padEnd(10)}] ${pick.version} - ${pc.green("online")}`,
          );
          stats.downloaded++;
        } else {
          checkSpinner.stop(
            `${pc.red("✗")} [${os.padEnd(10)}] ${pick.version} - ${pc.red("OFFLINE")}`,
          );
          stats.failed++;
          failures.push({
            major,
            os,
            version: pick.version,
            error: "HEAD request returned error status / offline",
          });
          if (failFast) {
            printSummary(stats, failures, true);
            process.exitCode = 1;
            return;
          }
        }
        continue;
      }

      p.log.step(`  [${os.padEnd(10)}] ${pc.cyan(pick.version)}`);

      let bar: cliProgress.SingleBar | undefined;

      try {
        const result = await downloadFile(pick.url, downloadDest, timeoutMs, {
          onStart: (total, resumed) => {
            bar = new cliProgress.SingleBar(
              {
                format: `      ${pc.green("{bar}")} {percentage}% | {value_formatted} / {total_formatted}`,
                barCompleteChar: "\u2588",
                barIncompleteChar: "\u2591",
                hideCursor: true,
                clearOnComplete: true,
              },
              cliProgress.Presets.shades_classic,
            );

            bar.start(total ?? 0, 0, {
              value_formatted: "0 B",
              total_formatted: total ? fmtBytes(total) : "unknown",
            });
          },
          onProgress: (downloaded, total) => {
            if (bar) {
              bar.update(downloaded, {
                value_formatted: fmtBytes(downloaded),
                total_formatted: total ? fmtBytes(total) : "unknown",
              });
            }
          },
        });

        if (bar) {
          bar.stop();
        }

        // Handle CRX to ZIP conversion
        if (isCrx) {
          const unpackSpinner = p.spinner();
          unpackSpinner.start("Unpacking CRX3 package to ZIP...");
          try {
            await unpackCrxFile(downloadDest, dest);
            unpackSpinner.stop("Unpacked successfully to ZIP.");
          } catch (unpackErr: any) {
            unpackSpinner.stop("Failed to unpack CRX3.");
            throw new Error(`CRX unpack error: ${unpackErr.message}`);
          }
        }

        const finalSize = fs.statSync(dest).size;
        if (result.status === "skipped") {
          p.log.success(
            `      ${pc.green("✓")} already downloaded (${fmtBytes(finalSize)})`,
          );
          stats.skipped++;
        } else if (result.status === "resumed") {
          p.log.success(
            `      ${pc.green("✓")} resumed and completed (${fmtBytes(finalSize)})`,
          );
          stats.resumed++;
        } else {
          p.log.success(
            `      ${pc.green("✓")} downloaded (${fmtBytes(finalSize)})`,
          );
          stats.downloaded++;
        }
      } catch (err: unknown) {
        if (bar) {
          bar.stop();
        }

        const msg = (err as Error).message;
        p.log.error(`      ${pc.red("✗ ERROR:")} ${msg}`);
        stats.failed++;
        failures.push({ major, os, version: pick.version, error: msg });

        if (failFast) {
          printSummary(stats, failures);
          process.exitCode = 1;
          return;
        }
      }
    }
  }

  printSummary(stats, failures, dryRun);
  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

/**
 * Print execution run report.
 */
function printSummary(
  stats: DownloadStats,
  failures: FailureInfo[],
  isCheck = false,
): void {
  if (isCheck) {
    p.note(
      [
        `${pc.green("Online")}      : ${pc.bold(String(stats.downloaded))}`,
        `${pc.yellow("Unavailable")} : ${pc.bold(String(stats.missing))}`,
        `${pc.red("Offline")}     : ${pc.bold(String(stats.failed))}`,
      ].join("\n"),
      "Verification Summary",
    );
  } else {
    p.note(
      [
        `${pc.green("Downloaded")}   : ${pc.bold(String(stats.downloaded))}`,
        `${pc.blue("Resumed")}      : ${pc.bold(String(stats.resumed))}`,
        `${pc.cyan("Skipped")}      : ${pc.bold(String(stats.skipped))}`,
        `${pc.yellow("Unavailable")}  : ${pc.bold(String(stats.missing))}`,
        `${pc.red("Failed")}       : ${pc.bold(String(stats.failed))}`,
      ].join("\n"),
      "Summary",
    );
  }

  if (failures.length > 0) {
    p.log.warn(
      `Failures (run again to retry):\n` +
        failures
          .map(
            (f) =>
              `  ${pc.red("✗")} ${f.major}/${f.os} ${f.version}: ${f.error}`,
          )
          .join("\n"),
    );
  }
}
