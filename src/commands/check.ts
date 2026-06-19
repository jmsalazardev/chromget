import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import cliProgress from "cli-progress";
import { httpRequest, BROWSER_USER_AGENT } from "../lib/http.js";
import { compareVersions } from "../lib/versions.js";
import type { ChromeDatabase } from "../lib/types.js";

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
 * Checks a single URL health status using HEAD → GET+Range → GET fallback.
 */
async function checkUrlHealth(url: string, timeoutMs: number): Promise<{
  status: "online" | "offline";
  checkedAt: string;
  size: number | null;
  error?: string;
}> {
  // 1. HEAD
  try {
    const res = await httpRequest(url, { "User-Agent": BROWSER_USER_AGENT }, timeoutMs, "HEAD");
    res.resume();
    const statusCode = res.statusCode ?? 500;
    if (statusCode >= 200 && statusCode < 400) {
      const contentLengthStr = getSingleHeader(res.headers["content-length"]);
      const size = contentLengthStr ? parseInt(contentLengthStr, 10) : null;
      return { status: "online", checkedAt: new Date().toISOString(), size };
    }
  } catch { /* fall back */ }

  // 2. GET with Range
  try {
    const res = await httpRequest(url, { "User-Agent": BROWSER_USER_AGENT, "Range": "bytes=0-0" }, timeoutMs, "GET");
    const statusCode = res.statusCode ?? 500;
    const isSuccess = statusCode === 200 || statusCode === 206;
    let size: number | null = null;
    if (statusCode === 206 && res.headers["content-range"]) {
      const match = /\/(\d+)\s*$/.exec(res.headers["content-range"]);
      if (match?.[1]) size = parseInt(match[1], 10);
    } else if (statusCode === 200 && res.headers["content-length"]) {
      size = parseInt(res.headers["content-length"], 10);
    }
    res.destroy();
    if (isSuccess) return { status: "online", checkedAt: new Date().toISOString(), size };
    if (statusCode !== 503) return { status: "offline", checkedAt: new Date().toISOString(), size: null, error: `HTTP ${statusCode}` };
  } catch { /* fall back */ }

  // 3. Plain GET
  try {
    const res = await httpRequest(url, { "User-Agent": BROWSER_USER_AGENT }, timeoutMs, "GET");
    const statusCode = res.statusCode ?? 500;
    const size = res.headers["content-length"] ? parseInt(res.headers["content-length"], 10) : null;
    res.destroy();
    if (statusCode >= 200 && statusCode < 400) {
      return { status: "online", checkedAt: new Date().toISOString(), size };
    }
    return { status: "offline", checkedAt: new Date().toISOString(), size: null, error: `HTTP ${statusCode}` };
  } catch (err) {
    return { status: "offline", checkedAt: new Date().toISOString(), size: null, error: (err as Error).message || "Unknown network error" };
  }
}

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
        onProgress?.();
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function runCheck(cmdOptions: CheckCommandOptions): Promise<void> {
  p.intro(pc.bgBlue(pc.black(" chromget check ")));

  const force = !!cmdOptions.force;
  const concurrency = cmdOptions.concurrency ? parseInt(cmdOptions.concurrency, 10) : 10;
  const timeoutMs = cmdOptions.timeout ? parseInt(cmdOptions.timeout, 10) : 10_000;

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

  const downloadsPath = path.resolve("chrome-downloads.json");
  let downloads: Record<string, any> = {};
  if (fs.existsSync(downloadsPath)) {
    try {
      downloads = JSON.parse(fs.readFileSync(downloadsPath, "utf8"));
    } catch {
      // ignore
    }
  }

  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  interface ScheduledTask {
    version: string;
    target: string;
    url: string;
  }

  const tasksToRun: ScheduledTask[] = [];
  let totalUrls = 0;
  let skippedCount = 0;

  for (const [version, targets] of Object.entries(chromeDb)) {
    for (const [target, value] of Object.entries(targets)) {
      if (target === "releaseDate") continue;
      if (!Array.isArray(value)) continue;

      const mirrors = value as string[];
      for (const url of mirrors) {
        totalUrls++;

        const existingMeta = downloads[url];
        if (existingMeta && existingMeta.checkedAt && existingMeta.status && !force) {
          const checkTime = new Date(existingMeta.checkedAt).getTime();
          if (checkTime > oneHourAgo) {
            skippedCount++;
            continue;
          }
        }

        tasksToRun.push({ version, target, url });
      }
    }
  }

  p.log.info(`Found ${pc.cyan(totalUrls)} total mirror URLs in database.`);
  if (skippedCount > 0) {
    p.log.info(`Skipped ${pc.green(skippedCount)} URLs checked in the last hour (use ${pc.yellow("--force")} to re-check).`);
  }

  if (tasksToRun.length === 0) {
    p.log.success(pc.green("All URLs are recently verified. No checks needed!"));
    p.outro("Done.");
    return;
  }

  p.log.info(`Checking ${pc.cyan(tasksToRun.length)} URLs with concurrency limit of ${pc.bold(concurrency)}...`);

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

  const checkTasks = tasksToRun.map((task) => {
    return async () => {
      const result = await checkUrlHealth(task.url, timeoutMs);
      downloads[task.url] = {
        status: result.status,
        checkedAt: result.checkedAt,
        size: result.size,
        error: result.error || null,
      };
    };
  });

  await runWithConcurrency(checkTasks, concurrency, () => bar.increment());
  bar.stop();
  p.log.info("Checks complete! Saving status to chrome-downloads.json...");

  try {
    fs.writeFileSync(downloadsPath, JSON.stringify(downloads, null, 2), "utf8");
    p.log.success(`Successfully saved health status to: ${pc.cyan(downloadsPath)}`);
  } catch (err) {
    p.log.error(pc.red(`Failed to write chrome-downloads.json: ${(err as Error).message}`));
  }

  let onlineCount = 0;
  let offlineCount = 0;
  let uncheckedCount = 0;

  for (const [version, targets] of Object.entries(chromeDb)) {
    for (const [target, value] of Object.entries(targets)) {
      if (target === "releaseDate") continue;
      if (!Array.isArray(value)) continue;

      for (const url of value) {
        const meta = downloads[url];
        if (meta) {
          if (meta.status === "online") onlineCount++;
          else if (meta.status === "offline") offlineCount++;
        } else {
          uncheckedCount++;
        }
      }
    }
  }

  p.log.info("\n" + pc.bold("Verification Summary:"));
  p.log.step(`  Online    : ${pc.green(onlineCount)}`);
  p.log.step(`  Offline   : ${offlineCount > 0 ? pc.red(offlineCount) : pc.green(0)}`);
  p.log.step(`  Unchecked : ${pc.yellow(uncheckedCount)}`);
  p.log.step(`  Skipped   : ${pc.yellow(skippedCount)}`);
  p.log.step(`  Total URLs: ${totalUrls}`);

  p.outro("Check workflow complete.");
}
