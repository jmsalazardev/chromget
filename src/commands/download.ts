import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import cliProgress from "cli-progress";
import { buildPlan } from "../lib/versions.js";
import { downloadWithFallback } from "../lib/downloader.js";
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
import { fetchDatabaseFromGitHub } from "../lib/github.js";
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
  process.setMaxListeners(50);

  const failFast = !!cmdOptions.failFast;
  const dryRun = !!cmdOptions.dryRun;
  const timeoutMs = cmdOptions.timeout
    ? parseInt(cmdOptions.timeout, 10)
    : 60_000;

  let osTargets: OsTarget[] = [
    "win_x86",
    "win_x64",
    "mac_x64",
    "mac_arm64",
    "linux_x64",
    "linux_x64_rpm",
  ];
  let customOutputDir = cmdOptions.output;

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

    // Interactive OS target selection
    if (!cmdOptions.os || cmdOptions.os.length === 0) {
      const osResponse = await p.multiselect({
        message: "Select operating system targets to download:",
        options: [
          { value: "win_x86", label: "Windows x86 (win_x86)" },
          { value: "win_x64", label: "Windows x64 (win_x64)" },
          { value: "mac_x64", label: "Mac Intel (mac_x64)" },
          { value: "mac_arm64", label: "Mac Apple Silicon (mac_arm64)" },
          { value: "linux_x64", label: "Linux Debian/Ubuntu (linux_x64)" },
          { value: "linux_x64_rpm", label: "Linux RedHat/Fedora (linux_x64_rpm)" },
        ],
        initialValues: ["win_x64", "mac_x64", "linux_x64"],
      });

      if (p.isCancel(osResponse)) {
        return cancel();
      }

      osTargets = osResponse as OsTarget[];
    }

    // Interactive output directory selection
    if (!cmdOptions.output) {
      const dirResponse = await p.text({
        message: "Specify the directory to save downloaded files:",
        placeholder: "chrome-downloads",
        defaultValue: "chrome-downloads",
      });

      if (p.isCancel(dirResponse)) {
        return cancel();
      }

      customOutputDir = dirResponse || "chrome-downloads";
    }
  }

  // Parse OS targets if they were passed via CLI options
  if (cmdOptions.os && cmdOptions.os.length > 0) {
    const filtered = cmdOptions.os
      .flatMap((o) => o.split(","))
      .map((o) => o.trim())
      .filter((o) => [
        "win_x86",
        "win_x64",
        "mac_x64",
        "mac_arm64",
        "linux_x64",
        "linux_x64_rpm",
      ].includes(o)) as OsTarget[];
    if (filtered.length > 0) {
      osTargets = filtered;
    }
  }

  const outputDir = path.resolve(customOutputDir || "chrome-downloads");

  const spinner = p.spinner();
  spinner.start("Fetching available Chrome releases from GitHub...");
  let versions: ChromeDatabase;
  try {
    versions = await fetchDatabaseFromGitHub();
    spinner.stop("Successfully synchronized with GitHub Releases.");
  } catch (err: any) {
    spinner.stop("Failed to synchronize with GitHub Releases. Using offline fallback.", 1);
    p.log.warn(pc.yellow(`Reason: ${err.message}`));
    versions = chromeJson as unknown as ChromeDatabase;
  }

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
      const candidates = picks[os];
      if (!candidates || candidates.length === 0) {
        p.log.step(
          `  [${os.padEnd(10)}] ${pc.yellow("not available in major " + major)}`,
        );
        stats.missing++;
        continue;
      }

      let success = false;
      const candidateErrors: string[] = [];

      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        const pick = candidates[cIdx]!;

        const firstMirrorUrl = pick.mirrors[0] ?? "";
        const urlExt = path.extname(new URL(firstMirrorUrl).pathname);

        const parts = os.split("_");
        const osName = parts[0] ?? os;
        const archName = parts[1] ?? "x64";

        const KNOWN_BINARY_EXTS = new Set([".exe", ".deb", ".rpm", ".dmg", ".pkg", ".zip", ".crx3"]);
        const OS_DEFAULT_EXT: Record<string, string> = {
          win_x86: ".exe",
          win_x64: ".exe",
          mac_x64: ".dmg",
          mac_arm64: ".dmg",
          linux_x64: ".deb",
          linux_x64_rpm: ".rpm",
        };
        const ext = KNOWN_BINARY_EXTS.has(urlExt) ? urlExt : (OS_DEFAULT_EXT[os] ?? urlExt);

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

        if (fs.existsSync(dest)) {
          p.log.success(
            `  [${os.padEnd(10)}] ${pc.cyan(pick.version)}: already downloaded (${fmtBytes(fs.statSync(dest).size)})`,
          );
          stats.skipped++;
          
          // Backfill missing hash if any
          const firstMirrorUrl = pick.mirrors[0];
          if (firstMirrorUrl) {
            await backfillDownloadMetadata(firstMirrorUrl, fs.statSync(dest).size, dest);
          }
          
          success = true;
          break;
        }

        if (dryRun) {
          p.log.success(
            `  [${os.padEnd(10)}] ${pc.cyan(pick.version)} - planned (${pick.mirrors.length} mirrors)`,
          );
          for (let mIdx = 0; mIdx < pick.mirrors.length; mIdx++) {
            p.log.step(`        ↳ Mirror ${mIdx + 1}: ${pc.dim(pick.mirrors[mIdx]!)}`);
          }
          stats.downloaded++;
          success = true;
          break;
        }

        const mirrorsLabel = pick.mirrors.length > 1
          ? ` (${pick.mirrors.length} mirrors)`
          : "";
        p.log.step(`  [${os.padEnd(10)}] ${pc.cyan(pick.version)}${pc.dim(mirrorsLabel)}`);

        let bar: cliProgress.SingleBar | undefined;

        try {
          const result = await downloadWithFallback(
            pick.mirrors,
            downloadDest,
            timeoutMs,
            {
              onStart: (total, _resumed) => {
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
            },
            (mirrorUrl, index, total) => {
              if (total > 1 && index > 0) {
                p.log.info(`      ${pc.yellow("⟳")} Trying mirror ${index + 1}/${total}...`);
              }
            },
            (mirrorUrl, error) => {
              if (bar) {
                bar.stop();
                bar = undefined;
              }
              if (pick.mirrors.length > 1) {
                p.log.warn(`      ${pc.yellow("⚠")} Mirror failed: ${error}`);
              }
            },
          );

          if (bar) {
            bar.stop();
          }

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

          const finalSize = result.size;
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
            if (result.mirrorUrl) {
              await saveDownloadMetadata(result.mirrorUrl, result.size || finalSize, dest);
            }
          } else {
            p.log.success(
              `      ${pc.green("✓")} downloaded (${fmtBytes(finalSize)})`,
            );
            stats.downloaded++;
            if (result.mirrorUrl) {
              await saveDownloadMetadata(result.mirrorUrl, result.size || finalSize, dest);
            }
          }

          success = true;
          break;
        } catch (err: unknown) {
          if (bar) {
            bar.stop();
          }

          const msg = (err as Error).message;
          p.log.warn(`      ${pc.yellow("⚠")} Version ${pick.version} failed: ${msg}`);
          candidateErrors.push(`Version ${pick.version}: ${msg}`);
        }
      }

      if (!success) {
        const errorSummary = candidateErrors.join("; ");
        p.log.error(
          `      ${pc.red("✗ ERROR:")} All candidate versions failed:\n        ` +
            candidateErrors.map((e) => `• ${e}`).join("\n        "),
        );
        stats.failed++;
        failures.push({
          major,
          os,
          version: candidates.map((c) => c.version).join(", "),
          error: errorSummary,
        });

        if (failFast) {
          printSummary(stats, failures, dryRun);
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

function printSummary(
  stats: DownloadStats,
  failures: FailureInfo[],
  isCheck = false,
): void {
  if (isCheck) {
    p.note(
      [
        `${pc.green("Planned")}     : ${pc.bold(String(stats.downloaded))}`,
        `${pc.cyan("Skipped")}     : ${pc.bold(String(stats.skipped))}`,
        `${pc.yellow("Unavailable")} : ${pc.bold(String(stats.missing))}`,
      ].join("\n"),
      "Dry-Run Plan Summary",
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

/**
 * Calculates the SHA-256 hash of a file.
 */
function calculateSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Saves metadata of a downloaded file to chrome-downloads.json, including its SHA-256 hash.
 */
/**
 * Saves metadata of a downloaded file to chrome-downloads.json, including its SHA-256 hash.
 * Also generates a .sha256 sidecar file next to the binary.
 */
async function saveDownloadMetadata(url: string, size: number, filePath: string): Promise<void> {
  const metadataPath = path.resolve("chrome-downloads.json");
  let data: Record<string, any> = {};
  if (fs.existsSync(metadataPath)) {
    try {
      data = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch {
      // ignore
    }
  }

  let sha256 = null;
  try {
    sha256 = await calculateSha256(filePath);
    
    // Write standard sidecar .sha256 file
    const shaPath = `${filePath}.sha256`;
    fs.writeFileSync(shaPath, `${sha256}  ${path.basename(filePath)}\n`, "utf8");
  } catch {
    // ignore
  }

  data[url] = {
    status: "online",
    checkedAt: new Date().toISOString(),
    size: size,
    sha256: sha256,
    error: null,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Checks and backfills SHA-256 metadata and .sha256 sidecar files for already downloaded files if missing.
 */
async function backfillDownloadMetadata(url: string, size: number, filePath: string): Promise<void> {
  const metadataPath = path.resolve("chrome-downloads.json");
  let data: Record<string, any> = {};
  if (fs.existsSync(metadataPath)) {
    try {
      data = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch {
      // ignore
    }
  }

  const shaPath = `${filePath}.sha256`;
  if (!data[url] || !data[url].sha256 || !fs.existsSync(shaPath)) {
    let sha256 = null;
    try {
      sha256 = await calculateSha256(filePath);
      
      // Write standard sidecar .sha256 file
      fs.writeFileSync(shaPath, `${sha256}  ${path.basename(filePath)}\n`, "utf8");
    } catch {
      // ignore
    }

    data[url] = {
      status: "online",
      checkedAt: data[url]?.checkedAt || new Date().toISOString(),
      size: size,
      sha256: sha256,
      error: null,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), "utf8");
  }
}
