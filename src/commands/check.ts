import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import cliProgress from "cli-progress";
import { httpRequest, BROWSER_USER_AGENT } from "../lib/http.js";
import { compareVersions } from "../lib/versions.js";
import chromeJson from "../resources/chrome.json" with { type: "json" };
import type { ChromeDatabase, ChromeRelease } from "../lib/types.js";

interface CheckCommandOptions {
  force?: boolean;
  concurrency?: string;
  timeout?: string;
}

function getSingleHeader(h: string | string[] | undefined): string | null {
  if (Array.isArray(h)) return h[0] ?? null;
  return h ?? null;
}

/**
 * Checks a single URL health status using a HEAD request, falling back to GET with range limits
 * if the HEAD request fails or returns a status code >= 400 (e.g. 503 Service Unavailable).
 */
async function checkUrlHealth(url: string, timeoutMs: number): Promise<{
  status: "online" | "offline";
  checkedAt: string;
  size: number | null;
  error?: string;
}> {
  // 1. Try HEAD request first
  try {
    const res = await httpRequest(
      url,
      { "User-Agent": BROWSER_USER_AGENT },
      timeoutMs,
      "HEAD"
    );
    res.resume(); // Consume/release stream
    
    const statusCode = res.statusCode ?? 500;
    if (statusCode >= 200 && statusCode < 400) {
      const contentLengthStr = getSingleHeader(res.headers["content-length"]);
      const size = contentLengthStr ? parseInt(contentLengthStr, 10) : null;
      return {
        status: "online",
        checkedAt: new Date().toISOString(),
        size,
      };
    }
  } catch (err) {
    // Ignore and fall back to GET
  }

  // 2. Try GET request with partial range
  try {
    const res = await httpRequest(
      url,
      { 
        "User-Agent": BROWSER_USER_AGENT,
        "Range": "bytes=0-0"
      },
      timeoutMs,
      "GET"
    );
    
    const statusCode = res.statusCode ?? 500;
    const isSuccess = statusCode === 200 || statusCode === 206;

    let size: number | null = null;
    if (statusCode === 206 && res.headers["content-range"]) {
      const match = /\/(\d+)\s*$/.exec(res.headers["content-range"]);
      if (match && match[1]) {
        size = parseInt(match[1], 10);
      }
    } else if (statusCode === 200 && res.headers["content-length"]) {
      size = parseInt(res.headers["content-length"], 10);
    }

    // Abort connection to avoid downloading the payload body
    res.destroy();

    if (isSuccess) {
      return {
        status: "online",
        checkedAt: new Date().toISOString(),
        size,
      };
    }
    // Only fail if not a 503 (server unavailable) - could be blocking Range requests
    if (statusCode !== 503) {
      return {
        status: "offline",
        checkedAt: new Date().toISOString(),
        size: null,
        error: `HTTP ${statusCode}`,
      };
    }
  } catch (err) {
    // Ignore and fall back to plain GET
  }

  // 3. Fallback: plain GET without Range header (for servers that block HEAD/Range like Slimjet)
  try {
    const res = await httpRequest(
      url,
      { "User-Agent": BROWSER_USER_AGENT },
      timeoutMs,
      "GET"
    );

    const statusCode = res.statusCode ?? 500;
    const size = res.headers["content-length"]
      ? parseInt(res.headers["content-length"], 10)
      : null;

    // Abort immediately after getting headers to avoid downloading the full body
    res.destroy();

    if (statusCode >= 200 && statusCode < 400) {
      return {
        status: "online",
        checkedAt: new Date().toISOString(),
        size,
      };
    } else {
      return {
        status: "offline",
        checkedAt: new Date().toISOString(),
        size: null,
        error: `HTTP ${statusCode}`,
      };
    }
  } catch (err) {
    return {
      status: "offline",
      checkedAt: new Date().toISOString(),
      size: null,
      error: (err as Error).message || "Unknown network error",
    };
  }
}

/**
 * Concurrency worker runner.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  onProgress?: () => void
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  const worker = async () => {
    while (index < tasks.length) {
      const currentIndex = index++;
      const task = tasks[currentIndex];
      if (task) {
        results[currentIndex] = await task();
        if (onProgress) onProgress();
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Runs the check command workflow.
 */
export async function runCheck(cmdOptions: CheckCommandOptions): Promise<void> {
  p.intro(pc.bgBlue(pc.black(" chromget check ")));

  const force = !!cmdOptions.force;
  const concurrency = cmdOptions.concurrency ? parseInt(cmdOptions.concurrency, 10) : 10;
  const timeoutMs = cmdOptions.timeout ? parseInt(cmdOptions.timeout, 10) : 10_000;

  // Resolve chrome.json path
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  let jsonPath = path.resolve(__dirname, "../resources/chrome.json");
  if (!fs.existsSync(jsonPath)) {
    jsonPath = path.resolve(__dirname, "../src/resources/chrome.json");
  }

  if (!fs.existsSync(jsonPath)) {
    p.log.error(pc.red(`Error: Could not locate chrome.json database at:\n${jsonPath}`));
    return;
  }

  p.log.info(`Reading database from: ${pc.cyan(jsonPath)}`);
  
  let chromeDb: ChromeDatabase = {};
  try {
    chromeDb = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as ChromeDatabase;
  } catch (err) {
    p.log.error(pc.red(`Failed to parse chrome.json: ${(err as Error).message}`));
    return;
  }

  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  // Scan database to determine which URLs need checking
  interface ScheduledTask {
    version: string;
    target: string;
    url: string;
  }

  const tasksToRun: ScheduledTask[] = [];
  let totalUrls = 0;
  let skippedCount = 0;

  const newChromeDb: ChromeDatabase = {};

  for (const [version, targets] of Object.entries(chromeDb)) {
    newChromeDb[version] = {} as any;
    if ((targets as any).releaseDate) {
      (newChromeDb[version] as any).releaseDate = (targets as any).releaseDate;
    }
    for (const [target, release] of Object.entries(targets)) {
      if (target === "releaseDate") continue;
      if (!release || !(release as any).url) continue;
      totalUrls++;

      if ((release as any).checkedAt && (release as any).status && !force) {
        const checkTime = new Date((release as any).checkedAt).getTime();
        if (checkTime > oneHourAgo) {
          // Re-use cached status
          (newChromeDb[version] as any)[target] = release;
          skippedCount++;
          continue;
        }
      }

      tasksToRun.push({ version, target, url: (release as any).url });
    }
  }

  p.log.info(`Found ${pc.cyan(totalUrls)} total URLs in database.`);
  if (skippedCount > 0) {
    p.log.info(`Skipped ${pc.green(skippedCount)} URLs checked in the last hour (use ${pc.yellow("--force")} to re-check).`);
  }

  if (tasksToRun.length === 0) {
    p.log.success(pc.green("All URLs are recently verified. No checks needed!"));
    p.outro("Done.");
    return;
  }

  p.log.info(`Checking ${pc.cyan(tasksToRun.length)} URLs with concurrency limit of ${pc.bold(concurrency)}...`);

  // Initialize progress bar
  const bar = new cliProgress.SingleBar(
    {
      format: `  Progress | ${pc.green("{bar}")} {percentage}% | {value}/{total} checked`,
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
      hideCursor: true,
      clearOnComplete: true,
    },
    cliProgress.Presets.shades_classic
  );

  bar.start(tasksToRun.length, 0);

  // Build tasks functions
  const checkTasks = tasksToRun.map((task) => {
    return async () => {
      const result = await checkUrlHealth(task.url, timeoutMs);
      const verObj = (newChromeDb[task.version] || {}) as any;
      newChromeDb[task.version] = verObj;
      
      const updatedRelease: ChromeRelease = {
        url: task.url,
        status: result.status,
        checkedAt: result.checkedAt,
        size: result.size,
      };

      if (result.error) {
        updatedRelease.error = result.error;
      }

      verObj[task.target] = updatedRelease;
    };
  });

  // Run tasks
  await runWithConcurrency(checkTasks, concurrency, () => {
    bar.increment();
  });

  bar.stop();
  p.log.info("Checks complete! Organizing database...");

  // Sort the database to match versions.json layout
  const sortedChromeDb: ChromeDatabase = {};
  const sortedKeys = Object.keys(newChromeDb).sort((a, b) => compareVersions(b, a));
  const osOrder = ["win_x86", "win_x64", "mac_x64", "mac_arm64", "linux_x64", "linux_x64_rpm"];

  let onlineCount = 0;
  let offlineCount = 0;
  let prunedVersionsCount = 0;

  for (const key of sortedKeys) {
    const targets = newChromeDb[key];
    if (!targets) continue;

    // Check if the version has at least one online or unchecked target (excluding releaseDate)
    const targetEntries = Object.entries(targets).filter(([k]) => k !== "releaseDate");
    const hasOnline = targetEntries.some(([_, r]) => r && (r as any).status === "online");
    const hasUnchecked = targetEntries.some(([_, r]) => r && !(r as any).status);

    if (targetEntries.length === 0 || (!hasOnline && !hasUnchecked)) {
      prunedVersionsCount++;
      continue;
    }

    const sortedTargets: any = {};
    const sortedOsKeys = Object.keys(targets).sort((a, b) => {
      return osOrder.indexOf(a) - osOrder.indexOf(b);
    });

    for (const osKey of sortedOsKeys) {
      const statusObj = (targets as any)[osKey];
      sortedTargets[osKey] = statusObj;
      if (osKey !== "releaseDate" && statusObj) {
        if (statusObj.status === "online") onlineCount++;
        else offlineCount++;
      }
    }
    sortedChromeDb[key] = sortedTargets;
  }

  // Write sorted database back to disk
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(sortedChromeDb, null, 2), "utf8");
    p.log.success(`Successfully saved health status to: ${pc.cyan(jsonPath)}`);
    if (prunedVersionsCount > 0) {
      p.log.info(`Auto-pruned ${pc.red(prunedVersionsCount)} versions that had 0 online targets.`);
    }
  } catch (err) {
    p.log.error(pc.red(`Failed to write chrome.json: ${(err as Error).message}`));
  }

  // Render final summary table
  p.log.info("\n" + pc.bold("Verification Summary:"));
  p.log.step(`  Online    : ${pc.green(onlineCount)}`);
  p.log.step(`  Offline   : ${offlineCount > 0 ? pc.red(offlineCount) : pc.green(0)}`);
  p.log.step(`  Skipped   : ${pc.yellow(skippedCount)}`);
  if (prunedVersionsCount > 0) {
    p.log.step(`  Pruned    : ${pc.red(prunedVersionsCount)} versions`);
  }
  p.log.step(`  Total URLs: ${totalUrls}`);

  p.outro("Check workflow complete.");
}
