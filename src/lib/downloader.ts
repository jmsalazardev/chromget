import fs from "node:fs";
import path from "node:path";
import { httpRequest, BROWSER_USER_AGENT } from "./http.js";
import type { DownloadResult } from "./types.js";

export interface DownloadHooks {
  onStart?: (totalBytes: number | null, resumed: boolean) => void;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
}

/**
 * Downloads a file from a URL to a local path.
 * Supports resumption (via HTTP Range requests) using `.part` files.
 * Verifies final file size against headers if available.
 */
export async function downloadFile(
  url: string,
  finalPath: string,
  timeoutMs = 60_000,
  hooks: DownloadHooks = {},
): Promise<DownloadResult> {
  // If the final file already exists, we skip it
  if (fs.existsSync(finalPath)) {
    const size = fs.statSync(finalPath).size;
    return { status: "skipped", size };
  }

  // Ensure the parent directory exists
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  const partPath = finalPath + ".part";
  let startByte = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;

  const headers: Record<string, string> = {
    "User-Agent": BROWSER_USER_AGENT,
  };

  if (startByte > 0) {
    headers["Range"] = `bytes=${startByte}-`;
  }

  const res = await httpRequest(url, headers, timeoutMs);
  const statusCode = res.statusCode ?? 500;

  let flags: "a" | "w";
  let resumed = false;

  if (statusCode === 206) {
    flags = "a"; // Partial Content: append
    resumed = true;
  } else if (statusCode === 200) {
    flags = "w"; // OK: overwrite/start new
    startByte = 0;
    resumed = false;
  } else {
    res.resume(); // Drain and discard response
    throw new Error(`HTTP ${statusCode} response when downloading ${url}`);
  }

  // Reject HTML responses (e.g. redirect/landing pages that return 200 with HTML)
  const contentType = res.headers["content-type"] ?? "";
  if (contentType.startsWith("text/html")) {
    res.resume();
    throw new Error(
      `Server returned HTML instead of a binary file (Content-Type: ${contentType}). ` +
        `The URL may be a redirect page that requires a browser.`,
    );
  }

  // Try to determine expected total size
  let total: number | null = null;
  if (statusCode === 200 && res.headers["content-length"]) {
    total = parseInt(res.headers["content-length"], 10);
  } else if (statusCode === 206 && res.headers["content-range"]) {
    const match = /\/(\d+)\s*$/.exec(res.headers["content-range"]);
    if (match && match[1]) {
      total = parseInt(match[1], 10);
    }
  }

  // Notify progress start
  hooks.onStart?.(total, resumed);

  await new Promise<void>((resolve, reject) => {
    const outStream = fs.createWriteStream(partPath, { flags });
    let downloaded = startByte;
    let lastLog = 0;

    res.on("data", (chunk: Buffer) => {
      downloaded += chunk.length;
      const now = Date.now();
      // Throttle progress events to 100ms intervals to prevent CLI flickering
      if (now - lastLog > 100) {
        hooks.onProgress?.(downloaded, total);
        lastLog = now;
      }
    });

    res.on("error", (err) => {
      outStream.destroy();
      reject(err);
    });

    outStream.on("error", (err) => {
      res.destroy();
      reject(err);
    });

    outStream.on("finish", () => {
      hooks.onProgress?.(downloaded, total);
      resolve();
    });

    res.pipe(outStream);
  });

  // Size verification
  const finalSize = fs.statSync(partPath).size;
  if (total !== null && finalSize !== total) {
    throw new Error(
      `size mismatch: final size is ${finalSize} B, expected ${total} B`,
    );
  }

  // Atomic rename to final path
  fs.renameSync(partPath, finalPath);

  return {
    status: resumed ? "resumed" : "downloaded",
    size: finalSize,
    mirrorUrl: url,
  };
}

/**
 * Attempts to download from a list of mirror URLs in order.
 * Returns the result from the first mirror that succeeds.
 * Throws with all errors if every mirror fails.
 */
export async function downloadWithFallback(
  mirrors: string[],
  finalPath: string,
  timeoutMs = 60_000,
  hooks: DownloadHooks = {},
  onMirrorAttempt?: (mirrorUrl: string, index: number, total: number) => void,
  onMirrorFail?: (mirrorUrl: string, error: string) => void,
): Promise<DownloadResult> {
  // If the final file already exists, skip immediately
  if (fs.existsSync(finalPath)) {
    const size = fs.statSync(finalPath).size;
    return { status: "skipped", size };
  }

  const errors: { url: string; error: string }[] = [];

  for (let i = 0; i < mirrors.length; i++) {
    const mirror = mirrors[i]!;

    onMirrorAttempt?.(mirror, i, mirrors.length);

    // Clean up any .part file from a previous failed mirror attempt
    const partPath = finalPath + ".part";
    if (i > 0 && fs.existsSync(partPath)) {
      fs.unlinkSync(partPath);
    }

    try {
      const result = await downloadFile(mirror, finalPath, timeoutMs, hooks);
      return { ...result, mirrorUrl: mirror };
    } catch (err: unknown) {
      const msg = (err as Error).message;
      errors.push({ url: mirror, error: msg });
      onMirrorFail?.(mirror, msg);
    }
  }

  // All mirrors failed
  const summary = errors
    .map((e, i) => `  Mirror ${i + 1}: ${e.url}\n    → ${e.error}`)
    .join("\n");
  throw new Error(`All ${mirrors.length} mirrors failed:\n${summary}`);
}
