import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import https from "node:https";
import http from "node:http";

// Helper to parse .env file
function loadEnv() {
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)\s*$/);
      if (match) {
        const key = match[1]!.trim();
        let val = match[2]!.trim();
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        } else if (val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

// Helper to check if destination or its mount point is ready/writable
function isDestAvailable(destPath: string): boolean {
  try {
    const resolved = path.resolve(destPath);
    
    // Target WSL/Linux mount points specifically
    const parts = resolved.split(path.sep);
    if (parts[1] === "mnt" && parts[2]) {
      const mountPoint = path.join("/", "mnt", parts[2]);
      fs.accessSync(mountPoint, fs.constants.F_OK);
      fs.statSync(mountPoint);
    }
    
    // General parent writability check
    let current = resolved;
    while (current && current !== path.dirname(current)) {
      if (fs.existsSync(current)) {
        fs.accessSync(current, fs.constants.W_OK);
        return true;
      }
      current = path.dirname(current);
    }
    return false;
  } catch {
    return false;
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
const source = args.find(a => a.startsWith("--source="))?.split("=")[1]?.toLowerCase();
const osArg = args.find(a => a.startsWith("--os="))?.split("=")[1]?.toLowerCase(); // win, mac, linux
const dest = args.find(a => a.startsWith("--dest="))?.split("=")[1] || process.env.CHROME_REPO_DEST || "/mnt/e/chrome-repo";

// Verify that destination is ready
if (!isDestAvailable(dest)) {
  console.error(`Error: Destination path '${dest}' is not ready or writable.`);
  process.exit(1);
}
const limitStr = args.find(a => a.startsWith("--limit="))?.split("=")[1];
const limit = limitStr ? parseInt(limitStr, 10) : Infinity;
const startStr = args.find(a => a.startsWith("--start="))?.split("=")[1];
const startIndex = startStr ? parseInt(startStr, 10) : 0;
const majorStr = args.find(a => a.startsWith("--major="))?.split("=")[1];
const filterMajor = majorStr ? parseInt(majorStr, 10) : null;

if (!source) {
  console.error("Error: Please specify a download source using the '--source' parameter.");
  console.error("Available sources: slimjet, cft, google, uchicago, uptodown");
  console.error("\nExample: npx tsx scripts/download.ts --source=uchicago --limit=5");
  throw new Error("Missing download source parameter.");
}

interface DownloadItem {
  version: string;
  url: string;
  os: string;
  arch: string;
  ext: string;
  // Uptodown specific fields
  fileID?: number;
  lastUpdate?: string;
  kindFile?: string;
}

// Ensure destination directory exists
if (!fs.existsSync(dest)) {
  fs.mkdirSync(dest, { recursive: true });
}

/**
 * Promise-based HTTP GET text content fetcher
 */
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(fetchText(nextUrl));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Promise-based HTTP GET JSON fetcher
 */
function fetchJson<T>(url: string): Promise<T> {
  return fetchText(url).then(text => JSON.parse(text) as T);
}

/**
 * Calculates SHA-256 hash of a file with retries for WSL filesystem latency.
 */
function calculateSha256(filePath: string, retries = 5, delayMs = 300): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let lastErr: any;
    for (let i = 0; i < retries; i++) {
      try {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        
        await new Promise<void>((resStream, rejStream) => {
          stream.on("open", () => resStream());
          stream.on("error", (err) => rejStream(err));
        });

        stream.on("data", (data) => hash.update(data));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", (err) => reject(err));
        return; // Success
      } catch (err: any) {
        lastErr = err;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    reject(lastErr || new Error(`Failed to open ${filePath} for SHA-256 calculation`));
  });
}

/**
 * Detects CPU architectures for Windows/Mac files.
 */
function getArchitectures(filePath: string, os: "win" | "mac", version: string, bitness: string | undefined): string[] {
  if (bitness === "64") return ["x64"];
  if (bitness === "32") return ["x86"];
  if (os === "mac") {
    const major = parseInt(version.split(".")[0], 10);
    if (major >= 87) return ["x64", "arm64"];
    return ["x64"];
  }
  try {
    const fileOutput = execSync(`file "${filePath}"`, { encoding: "utf8" });
    const lowerOutput = fileOutput.toLowerCase();
    if (lowerOutput.includes("x64") || lowerOutput.includes("x86-64") || lowerOutput.includes("x86_64") || lowerOutput.includes("template: x64") || lowerOutput.includes("template: amd64")) {
      return ["x64"];
    }
    if (lowerOutput.includes("intel 80386") || lowerOutput.includes("pe32 executable") || lowerOutput.includes("template: intel") || lowerOutput.includes("template: x86")) {
      return ["x86"];
    }
  } catch (err) {}
  const major = parseInt(version.split(".")[0], 10);
  if (major < 39) return ["x86"];
  return ["x64"];
}

/**
 * Ensures a file exists on disk (handles WSL/drvfs caching latencies).
 */
async function ensureFileExists(filePath: string, retries = 10, delayMs = 150): Promise<void> {
  for (let i = 0; i < retries; i++) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`File ${filePath} did not appear on the filesystem after rename.`);
}

/**
 * Standard direct downloader with range/resume support
 */
function downloadDirectFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const partPath = destPath + ".part";
    const startByte = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
    if (startByte > 0) {
      headers["Range"] = `bytes=${startByte}-`;
    }

    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers }, res => {
      const status = res.statusCode || 500;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(downloadDirectFile(nextUrl, destPath));
      }

      let append = false;
      let offset = 0;
      if (status === 206) {
        append = true;
        offset = startByte;
      } else if (status === 200) {
        append = false;
        offset = 0;
      } else {
        res.resume();
        return reject(new Error(`HTTP ${status} for ${url}`));
      }

      let total: number | null = null;
      if (status === 200 && res.headers["content-length"]) {
        total = parseInt(res.headers["content-length"], 10);
      } else if (status === 206 && res.headers["content-range"]) {
        const match = /\/(\d+)\s*$/.exec(res.headers["content-range"]);
        if (match && match[1]) total = parseInt(match[1], 10);
      }

      const outStream = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
      let downloaded = offset;
      let lastPercent = 0;

      res.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (total) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct - lastPercent >= 10 || pct === 100) {
            console.log(`  Progress: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
            lastPercent = pct;
          }
        }
      });

      res.on("error", err => {
        outStream.destroy();
        reject(err);
      });

      outStream.on("error", err => {
        res.destroy();
        reject(err);
      });

      outStream.on("finish", () => {
        try {
          fs.renameSync(partPath, destPath);
          resolve();
        } catch (err: any) {
          reject(new Error(`Failed to rename part file to final file: ${err.message}`));
        }
      });

      res.pipe(outStream);
    });

    req.on("error", reject);
  });
}

// ----------------------------------------------------
// SOURCES SCRAPING LOGIC
// ----------------------------------------------------

async function scrapeSlimjet(): Promise<DownloadItem[]> {
  console.log("Scraping Slimjet old versions...");
  const url = "https://www.slimjet.com/chrome/google-chrome-old-version.php";
  const html = await fetchText(url);
  const normalizedHtml = html.replace(/\s+/g, " ");
  const tagRegex = /<h2[^>]*>(.*?)<\/h2>|<h3[^>]*>(.*?)<\/h3>|<a[^>]+href=['"](download-chrome\.php\?file=[^'"]+)['"][^>]*>(.*?)<\/a>/gi;

  let currentOSGroup = "";
  let currentSubGroup = "";
  let match;
  const items: DownloadItem[] = [];

  while ((match = tagRegex.exec(normalizedHtml)) !== null) {
    if (match[1] !== undefined) {
      const text = match[1].replace(/<[^>]+>/g, "").trim().toLowerCase();
      if (text.includes("windows")) currentOSGroup = "windows";
      else if (text.includes("linux")) currentOSGroup = "linux";
      else if (text.includes("mac")) currentOSGroup = "mac";
      else currentOSGroup = "";
      currentSubGroup = "";
    } else if (match[2] !== undefined) {
      const text = match[2].replace(/<[^>]+>/g, "").trim().toLowerCase();
      if (text.includes("32-bit") || text.includes("32 bit")) currentSubGroup = "32";
      else if (text.includes("64-bit") || text.includes("64 bit")) currentSubGroup = "64";
      else currentSubGroup = "";
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[3].trim();
      const version = match[4].replace(/<[^>]+>/g, "").trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
        let os = "";
        let arch = "";
        if (currentOSGroup === "windows") {
          os = "win";
          arch = currentSubGroup === "32" ? "x86" : "x64";
        } else if (currentOSGroup === "linux" && currentSubGroup === "64") {
          os = "linux";
          arch = "x64";
        } else if (currentOSGroup === "mac") {
          os = "mac";
          arch = "x64";
        }

        if (os && arch) {
          const fileUrl = "https://www.slimjet.com/chrome/" + href;
          const ext = fileUrl.includes("Setup64.exe") || fileUrl.includes("Setup.exe") ? ".exe" : 
                      fileUrl.includes(".dmg") ? ".dmg" : 
                      fileUrl.includes(".deb") ? ".deb" : ".exe";
          items.push({ version, url: fileUrl, os, arch, ext });
        }
      }
    }
  }
  return items;
}

async function scrapeCft(): Promise<DownloadItem[]> {
  console.log("Fetching Chrome for Testing releases...");
  const url = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";
  const data = await fetchJson<any>(url);
  const items: DownloadItem[] = [];
  if (data && Array.isArray(data.versions)) {
    for (const entry of data.versions) {
      const version = entry.version;
      if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue;
      const chromeDls = entry.downloads.chrome;
      if (!chromeDls || chromeDls.length === 0) continue;
      for (const dl of chromeDls) {
        let os = "";
        let arch = "";
        if (dl.platform === "linux64") { os = "linux"; arch = "x64"; }
        else if (dl.platform === "mac-arm64") { os = "mac"; arch = "arm64"; }
        else if (dl.platform === "mac-x64") { os = "mac"; arch = "x64"; }
        else if (dl.platform === "win32") { os = "win"; arch = "x86"; }
        else if (dl.platform === "win64") { os = "win"; arch = "x64"; }
        
        if (os && arch) {
          const yandexUrl = dl.url.replace("https://storage.googleapis.com", "https://mirror.yandex.ru/mirrors/storage.googleapis.com");
          items.push({ version, url: yandexUrl, os, arch, ext: ".zip" });
        }
      }
    }
  }
  return items;
}

async function scrapeUChicago(): Promise<DownloadItem[]> {
  console.log("Scraping UChicago Linux mirror pool...");
  const url = "https://mirror.cs.uchicago.edu/google-chrome/pool/main/g/google-chrome-stable/";
  const html = await fetchText(url);
  const fileRegex = /href=["']google-chrome-stable_(\d+\.\d+\.\d+\.\d+)-1_amd64\.deb["']/gi;
  let match;
  const items: DownloadItem[] = [];
  while ((match = fileRegex.exec(html)) !== null) {
    const version = match[1];
    if (version) {
      items.push({
        version,
        url: `${url}google-chrome-stable_${version}-1_amd64.deb`,
        os: "linux",
        arch: "x64",
        ext: ".deb",
      });
    }
  }
  return items;
}

async function scrapeGoogle(): Promise<DownloadItem[]> {
  console.log("Scraping Google Chromium Dash releases...");
  const items: DownloadItem[] = [];
  const platforms = ["Windows", "Mac", "Linux"];
  const PAGE_SIZE = 100;
  const MAX_PAGES = 5;

  for (const plat of platforms) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=${plat}&num=${PAGE_SIZE}&offset=${offset}`;
      try {
        const releases = await fetchJson<any[]>(url);
        if (!Array.isArray(releases) || releases.length === 0) break;
        for (const release of releases) {
          const version = release.version;
          if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue;
          if (release.platform === "Linux") {
            items.push({
              version,
              url: `http://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}-1_amd64.deb`,
              os: "linux",
              arch: "x64",
              ext: ".deb",
            });
            items.push({
              version,
              url: `http://dl.google.com/linux/chrome/rpm/stable/x86_64/google-chrome-stable-${version}-1.x86_64.rpm`,
              os: "linux",
              arch: "x64",
              ext: ".rpm",
            });
          }
        }
        if (releases.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      } catch {
        break;
      }
    }
  }
  return items;
}

async function scrapeUptodown(targetOs: "windows" | "mac"): Promise<DownloadItem[]> {
  const osConfig = targetOs === "mac" ? { slug: "mac", appId: 10755, defaultExt: ".dmg" } : { slug: "windows", appId: 858, defaultExt: ".msi" };
  const listUrl = `https://google-chrome.en.uptodown.com/${osConfig.slug}/apps/${osConfig.appId}/versions`;
  console.log(`Scraping Uptodown versions for ${targetOs}...`);

  const versions: any[] = [];
  let page = 1;
  while (true) {
    const url = `${listUrl}/${page}`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const json = await res.json() as any;
      if (json.success !== 1 || !json.data || json.data.length === 0) break;
      versions.push(...json.data);
      page++;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch {
      break;
    }
  }

  return versions.map((v: any) => ({
    version: v.version,
    url: `https://google-chrome.en.uptodown.com/${osConfig.slug}/download/${v.fileID}`,
    os: targetOs === "mac" ? "mac" : "win",
    arch: "x64", // architecture will be auto-detected later by scanning binary
    ext: v.kindFile ? `.${v.kindFile}` : osConfig.defaultExt,
    fileID: v.fileID,
    lastUpdate: v.lastUpdate,
    kindFile: v.kindFile
  }));
}

// Cookie banner dismiss helper for Uptodown
async function dismissCookieBanner(page: any): Promise<void> {
  try {
    const frames = page.frames();
    for (const frame of frames) {
      const clicked = await frame.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("button, a, div[role='button']"));
        for (const el of elements) {
          const text = el.textContent?.trim().toUpperCase() || "";
          if (
            text === "ACCEPT ALL" ||
            text === "ACCEPT" ||
            text === "ACEPTAR TODO" ||
            text === "ACEPTAR" ||
            text === "AGREE" ||
            text === "REJECT ALL" ||
            text === "RECHAZAR TODO" ||
            text.includes("CONSENT")
          ) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return;
      }
    }
  } catch {}
}

async function waitForUptodownDownload(dir: string, timeoutMs: number = 300000): Promise<string> {
  const startTime = Date.now();
  let files: string[] = [];
  while (Date.now() - startTime < 45000) {
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).filter(f => !f.startsWith(".com.google"));
      if (files.length > 0) break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  if (files.length === 0) throw new Error("Download did not start within 45 seconds.");

  while (Date.now() - startTime < timeoutMs) {
    const currentFiles = fs.readdirSync(dir).filter(f => !f.startsWith(".com.google"));
    const hasPart = currentFiles.some(f => f.endsWith(".crdownload") || f.endsWith(".tmp"));
    const finished = currentFiles.filter(f => !f.endsWith(".crdownload") && !f.endsWith(".tmp"));
    
    if (finished.length > 0 && !hasPart) {
      const filePath = path.join(dir, finished[0]);
      const s1 = fs.statSync(filePath).size;
      await new Promise(resolve => setTimeout(resolve, 1000));
      const s2 = fs.statSync(filePath).size;
      if (s1 === s2 && s2 > 0) return filePath;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Download timed out.");
}

// ----------------------------------------------------
// MAIN RUNNER
// ----------------------------------------------------

async function main() {
  if (!source) {
    throw new Error("Missing download source parameter.");
  }
  console.log(`=========================================`);
  console.log(`  Unified Chrome Mirror Downloader Script`);
  console.log(`=========================================`);
  console.log(`Source:      ${source.toUpperCase()}`);
  console.log(`Destination: ${dest}`);
  console.log(`Limit:       ${limit}`);
  console.log(`Start index: ${startIndex}`);
  if (osArg) console.log(`OS filter:   ${osArg}`);
  if (filterMajor) console.log(`Major:       ${filterMajor}`);
  console.log(`=========================================`);

  let rawList: DownloadItem[] = [];

  // Scrape list based on source
  if (source === "slimjet") {
    rawList = await scrapeSlimjet();
  } else if (source === "cft") {
    rawList = await scrapeCft();
  } else if (source === "uchicago") {
    rawList = await scrapeUChicago();
  } else if (source === "google") {
    rawList = await scrapeGoogle();
  } else if (source === "uptodown") {
    const uptodownOS = osArg === "mac" ? "mac" : "windows";
    rawList = await scrapeUptodown(uptodownOS);
  } else {
    console.error(`Error: Unknown source '${source}'.`);
    process.exit(1);
  }

  // Apply filters
  let filteredList = rawList;

  // OS Filter
  if (osArg && source !== "uptodown") {
    filteredList = filteredList.filter(item => item.os.toLowerCase() === osArg);
  }

  // Major Version Filter
  if (filterMajor !== null) {
    filteredList = filteredList.filter(item => {
      const major = parseInt(item.version.split(".")[0] || "0", 10);
      return major === filterMajor;
    });
  }

  // Deduplicate items
  const seen = new Set<string>();
  filteredList = filteredList.filter(item => {
    const key = `${item.version}_${item.os}_${item.arch}_${item.ext}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Filter out already downloaded files before scheduling
  filteredList = filteredList.filter(item => {
    if (source === "uptodown") {
      const bitness = item.version.includes("64") ? "64" : item.version.includes("32") ? "32" : undefined;
      const testArchs = getArchitectures("", item.os as "win" | "mac", item.version, bitness);
      let exists = false;
      for (const arch of testArchs) {
        const finalName = `chrome_${item.version}_${item.os}_${arch}${item.ext}`;
        if (fs.existsSync(path.join(dest, finalName))) {
          exists = true;
          break;
        }
      }
      return !exists;
    } else {
      const filename = `chrome_${item.version}_${item.os}_${item.arch}${item.ext}`;
      const finalPath = path.join(dest, filename);
      return !fs.existsSync(finalPath);
    }
  });

  console.log(`\nFiltered queue: found ${filteredList.length} items to process.`);
  const queue = filteredList.slice(startIndex, startIndex + limit);
  console.log(`Queue size after start index and limit: ${queue.length} items.\n`);

  if (queue.length === 0) {
    console.log("No files to download based on filters.");
    return;
  }

  if (source === "uptodown") {
    // Launch browser for Uptodown
    let puppeteer;
    try {
      puppeteer = await import("puppeteer");
    } catch {
      console.error("Puppeteer is required to download from Uptodown.");
      console.error("Please install it: npm install -D puppeteer");
      process.exit(1);
    }

    console.log("Launching automated browser...");
    const browser = await puppeteer.default.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--safebrowsing-disable-download-protection", "--disable-features=SafeBrowsing"]
    });

    try {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]!;
        console.log(`[${i + 1}/${queue.length}] Processing Uptodown v${item.version} (fileID: ${item.fileID})...`);

        // Check if already downloaded
        const bitness = item.version.includes("64") ? "64" : item.version.includes("32") ? "32" : undefined;
        const testArchs = getArchitectures("", item.os as "win" | "mac", item.version, bitness);
        let exists = false;
        for (const arch of testArchs) {
          const finalName = `chrome_${item.version}_${item.os}_${arch}${item.ext}`;
          if (fs.existsSync(path.join(dest, finalName))) {
            exists = true;
          }
        }
        if (exists) {
          console.log(`  -> Already downloaded and organized. Skipping.`);
          continue;
        }

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        const tmpDir = path.join(dest, `tmp_download_uptodown_${item.fileID}`);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });

        const client = await page.target().createCDPSession();
        await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: tmpDir });

        try {
          await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 60000 });
          await new Promise(r => setTimeout(r, 2000));
          await dismissCookieBanner(page);

          try {
            await page.waitForSelector("button#detail-download-button", { timeout: 15000 });
            await page.evaluate(() => {
              const btn = document.querySelector("button#detail-download-button");
              if (btn) btn.scrollIntoView({ behavior: "smooth", block: "center" });
            });
            await new Promise(r => setTimeout(r, 2000));
            await dismissCookieBanner(page);

            const activeBtn = "button#detail-download-button.active";
            await page.waitForSelector(activeBtn, { visible: true, timeout: 15000 });
          } catch (btnErr) {
            console.log("  Warning: Download button not active, attempting click anyway...");
          }

          let started = false;
          for (let attempt = 1; attempt <= 6; attempt++) {
            console.log(`  Click attempt ${attempt}/6...`);
            try {
              await page.click("button#detail-download-button");
            } catch {
              await page.evaluate(() => {
                const btn = document.querySelector("button#detail-download-button") as HTMLElement;
                if (btn) btn.click();
              });
            }
            await new Promise(r => setTimeout(r, 3000));
            if (fs.existsSync(tmpDir) && fs.readdirSync(tmpDir).filter(f => !f.startsWith(".com.google")).length > 0) {
              started = true;
              break;
            }
          }

          if (!started) throw new Error("Download did not start.");

          console.log("  Waiting for file completion...");
          const downloadedPath = await waitForUptodownDownload(tmpDir);
          const extName = path.extname(downloadedPath) || item.ext;

          // Organize and resolve target architectures
          const architectures = getArchitectures(downloadedPath, item.os as "win" | "mac", item.version, bitness);
          console.log(`  Organizing targets: [${architectures.join(", ")}]`);

          for (let idx = 0; idx < architectures.length; idx++) {
            const arch = architectures[idx]!;
            const finalName = `chrome_${item.version}_${item.os}_${arch}${extName}`;
            const finalPath = path.join(dest, finalName);

            if (idx < architectures.length - 1) {
              fs.copyFileSync(downloadedPath, finalPath);
            } else {
              fs.renameSync(downloadedPath, finalPath);
            }

            console.log(`  ✓ Saved file: ${finalName}`);
            await ensureFileExists(finalPath);
            const sha256 = await calculateSha256(finalPath);
            fs.writeFileSync(`${finalPath}.sha256`, `${sha256}  ${finalName}\n`, "utf8");
            console.log(`  ✓ Sidecar generated: ${finalName}.sha256`);
          }
        } catch (downloadErr: any) {
          console.error(`  ✗ Error downloading v${item.version}: ${downloadErr.message}`);
        } finally {
          await page.close().catch(() => {});
          if (fs.existsSync(tmpDir)) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          }
        }
      }
    } finally {
      await browser.close();
      console.log("\nProcess complete!");
    }
  } else {
    // Direct HTTP downloading for direct mirrors
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]!;
      const filename = `chrome_${item.version}_${item.os}_${item.arch}${item.ext}`;
      const finalPath = path.join(dest, filename);

      console.log(`[${i + 1}/${queue.length}] Processing direct mirror v${item.version} for ${item.os}_${item.arch}...`);

      if (fs.existsSync(finalPath)) {
        console.log(`  -> Already downloaded: ${filename}. Skipping.`);
        continue;
      }

      try {
        console.log(`  Downloading URL: ${item.url}`);
        await downloadDirectFile(item.url, finalPath);
        console.log(`  ✓ Download complete: ${filename}`);

        // Generate SHA-256 sidecar
        console.log("  Calculating SHA-256...");
        await ensureFileExists(finalPath);
        const sha256 = await calculateSha256(finalPath);
        fs.writeFileSync(`${finalPath}.sha256`, `${sha256}  ${filename}\n`, "utf8");
        console.log(`  ✓ Generated sidecar: ${filename}.sha256`);
      } catch (err: any) {
        console.error(`  ✗ Failed to download v${item.version}: ${err.message}`);
        // Remove partial files if error occurred and they are present
        if (fs.existsSync(finalPath + ".part")) {
          try { fs.unlinkSync(finalPath + ".part"); } catch {}
        }
      }
      console.log("");
    }
    console.log("Process complete!");
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
