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
  };
}
