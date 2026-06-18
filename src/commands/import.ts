import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getText, getJson } from "../lib/http.js";
import { compareVersions } from "../lib/versions.js";
import type { ChromeDatabase, ChromeRelease } from "../lib/types.js";

const ULIXEE_URL = "https://raw.githubusercontent.com/ulixee/chrome-versions/refs/heads/main/versions.json";
const SLIMJET_URL = "https://www.slimjet.com/chrome/google-chrome-old-version.php";
const CFT_VERSIONS_URL = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";
const YANDEX_MIRROR_BASE = "https://mirror.yandex.ru/mirrors/storage.googleapis.com";
const GCS_BASE = "https://storage.googleapis.com";

const CFT_PLATFORM_MAPPING: Record<string, string> = {
  linux64: "linux_x64",
  "mac-arm64": "mac_arm64",
  "mac-x64": "mac_x64",
  win32: "win_x86",
  win64: "win_x64",
};

const ULIXEE_OS_MAPPING: Record<string, string> = {
  win32: "win_x86",
  win64: "win_x64",
  mac: "mac_x64",
  mac_arm64: "mac_arm64",
  linux: "linux_x64",
  linux_rpm: "linux_x64_rpm",
};

/**
 * Scrapes Google Chrome versions from Slimjet archive, fetches versions from the Ulixee
 * repository on GitHub, merges them into the local resource database, and saves it back sorted.
 */
export async function runImport(): Promise<void> {
  p.intro(pc.bgMagenta(pc.black(" chromget import ")));

  const s = p.spinner();

  // 1. Fetch Ulixee JSON
  s.start(`Fetching Ulixee versions from GitHub...`);
  let ulixeeData: Record<string, Record<string, string>>;
  try {
    ulixeeData = await getJson<Record<string, Record<string, string>>>(ULIXEE_URL);
    s.stop("Successfully downloaded Ulixee versions database.");
  } catch (err) {
    s.stop("Failed to fetch Ulixee versions.", 1);
    p.log.error(pc.red((err as Error).message));
    return;
  }

  // 2. Fetch Slimjet HTML
  s.start(`Fetching Slimjet archive from ${pc.cyan(SLIMJET_URL)}...`);
  let htmlContent: string;
  try {
    htmlContent = await getText(SLIMJET_URL);
    s.stop("Successfully downloaded Slimjet page.");
  } catch (err) {
    s.stop("Failed to fetch Slimjet page.", 1);
    p.log.error(pc.red((err as Error).message));
    return;
  }

  // 2b. Fetch Chromium Dash stable releases
  s.start("Fetching latest releases from Chromium Dash...");
  interface ChromiumDashRelease {
    channel: string;
    chromium_main_branch_position: number;
    hashes: {
      angle?: string;
      chromium?: string;
      dawn?: string;
      devtools?: string;
      pdfium?: string;
      skia?: string;
      v8?: string;
      webrtc?: string;
    };
    milestone: number;
    platform: string;
    previous_version: string;
    time: number;
    version: string;
  }

  const dashReleases: ChromiumDashRelease[] = [];
  const platforms = ["Windows", "Mac", "Linux"];
  const PAGE_SIZE = 100;
  const MAX_PAGES = 5; // up to 500 releases per platform

  for (const plat of platforms) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const url = `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=${plat}&num=${PAGE_SIZE}&offset=${offset}`;
        const data = await getJson<ChromiumDashRelease[]>(url);
        if (!Array.isArray(data) || data.length === 0) break;
        dashReleases.push(...data);
        if (data.length < PAGE_SIZE) break; // last page
        offset += PAGE_SIZE;
      } catch (err) {
        p.log.warn(pc.yellow(`Failed to fetch Chromium Dash releases for platform ${plat} (offset ${offset}): ${(err as Error).message}`));
        break;
      }
    }
  }
  s.stop(`Successfully fetched ${pc.cyan(dashReleases.length)} releases from Chromium Dash.`);

  // 2c. Fetch Chrome for Testing known-good versions (used to build Yandex mirror URLs)
  interface CftDownloadEntry { platform: string; url: string; }
  interface CftVersion {
    version: string;
    revision: string;
    downloads: { chrome?: CftDownloadEntry[]; [key: string]: CftDownloadEntry[] | undefined };
  }
  interface CftVersionsData { timestamp: string; versions: CftVersion[]; }

  s.start("Fetching Chrome for Testing version list...");
  let cftData: CftVersionsData | null = null;
  try {
    cftData = await getJson<CftVersionsData>(CFT_VERSIONS_URL);
    s.stop(`Successfully fetched ${pc.cyan(cftData.versions.length)} Chrome for Testing versions.`);
  } catch (err) {
    s.stop(pc.yellow("Failed to fetch Chrome for Testing versions (skipping Yandex mirror source)."), 1);
    p.log.warn(pc.yellow((err as Error).message));
  }

  // 3. Parse Slimjet HTML
  s.start("Parsing Slimjet HTML content and mapping versions...");
  const normalizedHtml = htmlContent.replace(/\s+/g, " ");
  const tagRegex = /<h2[^>]*>(.*?)<\/h2>|<h3[^>]*>(.*?)<\/h3>|<a[^>]+href=['"](download-chrome\.php\?file=[^'"]+)['"][^>]*>(.*?)<\/a>/gi;

  let currentOSGroup = "";
  let currentSubGroup = "";
  let match;
  const slimjetItems: { version: string; target: string; url: string }[] = [];
  let skipped32BitLinuxCount = 0;

  while ((match = tagRegex.exec(normalizedHtml)) !== null) {
    if (match[1] !== undefined) {
      const text = match[1].replace(/<[^>]+>/g, "").trim().toLowerCase();
      if (text.includes("windows")) {
        currentOSGroup = "windows";
      } else if (text.includes("linux")) {
        currentOSGroup = "linux";
      } else if (text.includes("mac")) {
        currentOSGroup = "mac";
      } else {
        currentOSGroup = "";
      }
      currentSubGroup = "";
    } else if (match[2] !== undefined) {
      const text = match[2].replace(/<[^>]+>/g, "").trim().toLowerCase();
      if (text.includes("32-bit") || text.includes("32 bit")) {
        currentSubGroup = "32";
      } else if (text.includes("64-bit") || text.includes("64 bit")) {
        currentSubGroup = "64";
      } else {
        currentSubGroup = "";
      }
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[3].trim();
      const version = match[4].replace(/<[^>]+>/g, "").trim();
      
      if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
        let target = "";
        if (currentOSGroup === "windows") {
          if (currentSubGroup === "32") target = "win_x86";
          else if (currentSubGroup === "64") target = "win_x64";
        } else if (currentOSGroup === "linux") {
          if (currentSubGroup === "64") target = "linux_x64";
          else if (currentSubGroup === "32") skipped32BitLinuxCount++;
        } else if (currentOSGroup === "mac") {
          target = "mac_x64";
        }

        if (target) {
          const fullUrl = "https://www.slimjet.com/chrome/" + href;
          slimjetItems.push({ version, target, url: fullUrl });
        }
      }
    }
  }
  s.stop(`Slimjet parsing complete. Found ${pc.cyan(slimjetItems.length)} valid version targets.`);
  if (skipped32BitLinuxCount > 0) {
    p.log.info(`Skipped ${pc.yellow(skipped32BitLinuxCount)} Linux 32-bit targets (unsupported).`);
  }

  // 4. Resolve JSON path
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

  p.log.info(`Reading existing database from: ${pc.cyan(jsonPath)}`);
  
  let versionsJson: ChromeDatabase;
  try {
    versionsJson = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as ChromeDatabase;
  } catch (err) {
    p.log.error(pc.red(`Failed to parse existing chrome.json: ${(err as Error).message}`));
    return;
  }

  // 5. Merge Ulixee
  let ulixeeAdded = 0;
  for (const [version, osMap] of Object.entries(ulixeeData)) {
    for (const [osKey, url] of Object.entries(osMap)) {
      const target = ULIXEE_OS_MAPPING[osKey];
      if (target) {
        if (!versionsJson[version]) {
          versionsJson[version] = {} as any;
        }
        if (!(versionsJson[version] as any)[target]) {
          (versionsJson[version] as any)[target] = { url };
          ulixeeAdded++;
        }
      }
    }
  }

  // 6. Merge Slimjet
  let slimjetAdded = 0;
  for (const item of slimjetItems) {
    const { version, target, url } = item;
    if (!versionsJson[version]) {
      versionsJson[version] = {} as any;
    }
    const existing = (versionsJson[version] as any)[target];
    if (!existing) {
      (versionsJson[version] as any)[target] = { url };
      slimjetAdded++;
    } else if (existing.status === "offline" && existing.url !== url) {
      p.log.info(
        pc.yellow(`[Slimjet Override] ${version} (${target}): Replacing offline URL with Slimjet URL`)
      );
      (versionsJson[version] as any)[target] = { url };
      slimjetAdded++;
    }
  }

  // 7. Merge Chrome for Testing (Yandex mirror) — ZIP packages for all 5 platforms
  let cftAdded = 0;
  if (cftData) {
    for (const entry of cftData.versions) {
      const version = entry.version;
      if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue;
      const chromeDls = entry.downloads.chrome;
      if (!chromeDls || chromeDls.length === 0) continue;

      for (const dl of chromeDls) {
        const target = CFT_PLATFORM_MAPPING[dl.platform];
        if (!target) continue;

        // Remap storage.googleapis.com → Yandex mirror
        const mirrorUrl = dl.url.replace(GCS_BASE, YANDEX_MIRROR_BASE);

        if (!versionsJson[version]) {
          versionsJson[version] = {} as any;
        }
        if (!(versionsJson[version] as any)[target]) {
          (versionsJson[version] as any)[target] = { url: mirrorUrl };
          cftAdded++;
        }
      }
    }
  }

  // 8. Merge & Enrich with Chromium Dash
  let dashAdded = 0;
  let dashEnriched = 0;
  for (const release of dashReleases) {
    const version = release.version;
    if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue;

    if (!versionsJson[version]) {
      versionsJson[version] = {} as any;
    }

    const prevDate = (versionsJson[version] as any).releaseDate;
    const newDate = new Date(release.time).toISOString();

    (versionsJson[version] as any).releaseDate = newDate;
    if (!prevDate) {
      dashEnriched++;
    }

    if (release.platform === "Linux") {
      const debUrl = `http://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}-1_amd64.deb`;
      const rpmUrl = `http://dl.google.com/linux/chrome/rpm/stable/x86_64/google-chrome-stable-${version}-1.x86_64.rpm`;

      if (!(versionsJson[version] as any).linux_x64) {
        (versionsJson[version] as any).linux_x64 = { url: debUrl };
        dashAdded++;
      }
      if (!(versionsJson[version] as any).linux_x64_rpm) {
        (versionsJson[version] as any).linux_x64_rpm = { url: rpmUrl };
        dashAdded++;
      }
    }
  }

  const totalAdded = ulixeeAdded + slimjetAdded + cftAdded + dashAdded + dashEnriched;
  if (totalAdded === 0) {
    p.log.success(pc.green("All parsed versions are already defined in the database. No updates needed."));
    p.outro("Done.");
    return;
  }

  s.start("Sorting and saving updated database...");

  // Sort versions descending
  const sortedVersions: ChromeDatabase = {};
  const sortedKeys = Object.keys(versionsJson).sort((a, b) => compareVersions(b, a));
  const osOrder = ["win_x86", "win_x64", "mac_x64", "mac_arm64", "linux_x64", "linux_x64_rpm"];

  for (const key of sortedKeys) {
    const targets = versionsJson[key];
    if (!targets) continue;
    const sortedTargets: any = {};
    const sortedOsKeys = Object.keys(targets).sort((a, b) => {
      return osOrder.indexOf(a) - osOrder.indexOf(b);
    });
    
    for (const osKey of sortedOsKeys) {
      sortedTargets[osKey] = (targets as any)[osKey];
    }
    sortedVersions[key] = sortedTargets;
  }

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(sortedVersions, null, 2), "utf8");
    s.stop("Saved updated chrome.json successfully.");
    p.log.success(
      pc.green(
        `Database updated! Added ${pc.bold(ulixeeAdded)} from Ulixee, ${pc.bold(slimjetAdded)} from Slimjet, ${pc.bold(cftAdded)} from Chrome for Testing (Yandex mirror), and enriched ${pc.bold(dashEnriched)} (added ${pc.bold(dashAdded)} targets) from Chromium Dash.`
      )
    );
  } catch (err) {
    s.stop("Failed to write updated database.", 1);
    p.log.error(pc.red((err as Error).message));
  }

  p.outro("Import complete.");
}
