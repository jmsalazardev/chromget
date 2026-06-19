import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getText, getJson } from "../lib/http.js";
import { compareVersions, addMirror } from "../lib/versions.js";
import type { ChromeDatabase } from "../lib/types.js";

const ULIXEE_URL = "https://raw.githubusercontent.com/ulixee/chrome-versions/refs/heads/main/versions.json";
const SLIMJET_URL = "https://www.slimjet.com/chrome/google-chrome-old-version.php";
const CFT_VERSIONS_URL = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";
const YANDEX_MIRROR_BASE = "https://mirror.yandex.ru/mirrors/storage.googleapis.com";
const GCS_BASE = "https://storage.googleapis.com";
const CHICAGO_URL = "https://mirror.cs.uchicago.edu/google-chrome/pool/main/g/google-chrome-stable/";

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
 * Scrapes Google Chrome versions from multiple sources, merges them into the
 * local resource database as mirrors, and saves it back sorted.
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
  const MAX_PAGES = 5;

  for (const plat of platforms) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const url = `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=${plat}&num=${PAGE_SIZE}&offset=${offset}`;
        const data = await getJson<ChromiumDashRelease[]>(url);
        if (!Array.isArray(data) || data.length === 0) break;
        dashReleases.push(...data);
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      } catch (err) {
        p.log.warn(pc.yellow(`Failed to fetch Chromium Dash releases for platform ${plat} (offset ${offset}): ${(err as Error).message}`));
        break;
      }
    }
  }
  s.stop(`Successfully fetched ${pc.cyan(dashReleases.length)} releases from Chromium Dash.`);

  // 2c. Fetch Chrome for Testing
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

  // 2d. Fetch Chicago mirror list
  s.start(`Fetching Chicago mirror archive from ${pc.cyan(CHICAGO_URL)}...`);
  let chicagoHtml = "";
  try {
    chicagoHtml = await getText(CHICAGO_URL);
    s.stop("Successfully downloaded Chicago mirror page.");
  } catch (err) {
    s.stop(pc.yellow("Failed to fetch Chicago mirror page (skipping UChicago mirror source)."), 1);
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
          slimjetItems.push({ version, target, url: "https://www.slimjet.com/chrome/" + href });
        }
      }
    }
  }
  s.stop(`Slimjet parsing complete. Found ${pc.cyan(slimjetItems.length)} valid version targets.`);
  if (skipped32BitLinuxCount > 0) {
    p.log.info(`Skipped ${pc.yellow(skipped32BitLinuxCount)} Linux 32-bit targets (unsupported).`);
  }

  // 3b. Parse Chicago HTML
  const chicagoItems: { version: string; url: string }[] = [];
  if (chicagoHtml) {
    s.start("Parsing Chicago HTML content and mapping versions...");
    const fileRegex = /href=["']google-chrome-stable_(\d+\.\d+\.\d+\.\d+)-1_amd64\.deb["']/gi;
    let match;
    while ((match = fileRegex.exec(chicagoHtml)) !== null) {
      const version = match[1];
      if (version) {
        chicagoItems.push({
          version,
          url: `${CHICAGO_URL}google-chrome-stable_${version}-1_amd64.deb`,
        });
      }
    }
    s.stop(`Chicago mirror parsing complete. Found ${pc.cyan(chicagoItems.length)} valid version targets.`);
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
        if (!versionsJson[version]) versionsJson[version] = {} as any;
        const existing = (versionsJson[version] as any)[target] as string[] | undefined;
        const updated = addMirror(existing, url);
        if (updated !== existing) {
          (versionsJson[version] as any)[target] = updated;
          ulixeeAdded++;
        }
      }
    }
  }

  // 6. Merge Slimjet
  let slimjetAdded = 0;
  for (const item of slimjetItems) {
    const { version, target, url } = item;
    if (!versionsJson[version]) versionsJson[version] = {} as any;
    const existing = (versionsJson[version] as any)[target] as string[] | undefined;
    const updated = addMirror(existing, url);
    if (updated !== existing) {
      (versionsJson[version] as any)[target] = updated;
      slimjetAdded++;
    }
  }

  // 7. Merge Chrome for Testing (Yandex mirror)
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
        const mirrorUrl = dl.url.replace(GCS_BASE, YANDEX_MIRROR_BASE);
        if (!versionsJson[version]) versionsJson[version] = {} as any;
        const existing = (versionsJson[version] as any)[target] as string[] | undefined;
        const updated = addMirror(existing, mirrorUrl);
        if (updated !== existing) {
          (versionsJson[version] as any)[target] = updated;
          cftAdded++;
        }
      }
    }
  }

  // 7b. Merge UChicago Mirror
  let chicagoAdded = 0;
  for (const item of chicagoItems) {
    const { version, url } = item;
    if (!versionsJson[version]) versionsJson[version] = {} as any;
    const existing = (versionsJson[version] as any).linux_x64 as string[] | undefined;
    const updated = addMirror(existing, url);
    if (updated !== existing) {
      (versionsJson[version] as any).linux_x64 = updated;
      chicagoAdded++;
    }
  }

  // 8. Merge & Enrich with Chromium Dash
  let dashAdded = 0;
  let dashEnriched = 0;
  for (const release of dashReleases) {
    const version = release.version;
    if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue;
    if (!versionsJson[version]) versionsJson[version] = {} as any;

    const prevDate = (versionsJson[version] as any).releaseDate;
    (versionsJson[version] as any).releaseDate = new Date(release.time).toISOString();
    if (!prevDate) dashEnriched++;

    if (release.platform === "Linux") {
      const debUrl = `http://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}-1_amd64.deb`;
      const rpmUrl = `http://dl.google.com/linux/chrome/rpm/stable/x86_64/google-chrome-stable-${version}-1.x86_64.rpm`;

      const existingDeb = (versionsJson[version] as any).linux_x64 as string[] | undefined;
      const updatedDeb = addMirror(existingDeb, debUrl);
      if (updatedDeb !== existingDeb) {
        (versionsJson[version] as any).linux_x64 = updatedDeb;
        dashAdded++;
      }

      const existingRpm = (versionsJson[version] as any).linux_x64_rpm as string[] | undefined;
      const updatedRpm = addMirror(existingRpm, rpmUrl);
      if (updatedRpm !== existingRpm) {
        (versionsJson[version] as any).linux_x64_rpm = updatedRpm;
        dashAdded++;
      }
    }
  }

  // 7e. Fetch and merge GitHub Release mirrors
  s.start("Fetching existing GitHub release assets...");
  const githubAssets = await fetchGitHubAssets();
  s.stop(`Successfully fetched ${pc.cyan(githubAssets.size)} assets from GitHub releases.`);

  let githubMirrorsAdded = 0;
  for (const [version, platforms] of Object.entries(versionsJson)) {
    for (const [os, mirrors] of Object.entries(platforms)) {
      if (!Array.isArray(mirrors) || mirrors.length === 0) continue;

      const filename = getExpectedFilename(version, os, mirrors);

      if (githubAssets.has(filename)) {
        const githubUrl = githubAssets.get(filename)!;
        if (mirrors[0] !== githubUrl) {
          const filtered = mirrors.filter(m => m !== githubUrl);
          (platforms as any)[os] = [githubUrl, ...filtered];
          githubMirrorsAdded++;
        }
      }
    }
  }

  const totalAdded = ulixeeAdded + slimjetAdded + cftAdded + dashAdded + dashEnriched + chicagoAdded + githubMirrorsAdded;
  if (totalAdded === 0) {
    p.log.success(pc.green("All parsed versions and GitHub mirrors are already defined in the database. No updates needed."));
    p.outro("Done.");
    return;
  }

  s.start("Sorting and saving updated database...");

  const sortedVersions: ChromeDatabase = {};
  const sortedKeys = Object.keys(versionsJson).sort((a, b) => compareVersions(b, a));
  const osOrder = ["win_x86", "win_x64", "mac_x64", "mac_arm64", "linux_x64", "linux_x64_rpm"];

  for (const key of sortedKeys) {
    const targets = versionsJson[key];
    if (!targets) continue;
    const sortedTargets: any = {};
    const sortedOsKeys = Object.keys(targets).sort((a, b) => osOrder.indexOf(a) - osOrder.indexOf(b));
    for (const osKey of sortedOsKeys) {
      sortedTargets[osKey] = (targets as any)[osKey];
    }
    sortedVersions[key] = sortedTargets;
  }

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(sortedVersions, null, 2), "utf8");
    s.stop("Saved updated chrome.json successfully.");
    
    let successMsg = `Database updated! Added ${pc.bold(ulixeeAdded)} mirrors from Ulixee, ${pc.bold(slimjetAdded)} from Slimjet, ${pc.bold(cftAdded)} from Chrome for Testing (Yandex mirror), ${pc.bold(chicagoAdded)} from UChicago, and enriched ${pc.bold(dashEnriched)} (added ${pc.bold(dashAdded)} targets) from Chromium Dash.`;
    if (githubMirrorsAdded > 0) {
      successMsg += ` Also prioritized ${pc.bold(githubMirrorsAdded)} uploaded GitHub mirror URLs.`;
    }
    p.log.success(pc.green(successMsg));
  } catch (err) {
    s.stop("Failed to write updated database.", 1);
    p.log.error(pc.red((err as Error).message));
  }

  p.outro("Import complete.");
}

const KNOWN_BINARY_EXTS = new Set([".exe", ".deb", ".rpm", ".dmg", ".pkg", ".zip", ".crx3"]);
const OS_DEFAULT_EXT: Record<string, string> = {
  win_x86: ".exe",
  win_x64: ".exe",
  mac_x64: ".dmg",
  mac_arm64: ".dmg",
  linux_x64: ".deb",
  linux_x64_rpm: ".rpm",
};

function getExpectedFilename(version: string, os: string, mirrors: string[]): string {
  const originalMirror = mirrors.find(m => m && typeof m === "string" && !m.includes("github.com/"));
  let urlExt = "";
  if (originalMirror) {
    try {
      urlExt = path.extname(new URL(originalMirror).pathname);
    } catch {
      // ignore
    }
  }

  const parts = os.split("_");
  const osName = parts[0] ?? os;
  const archName = parts[1] ?? "x64";

  const ext = KNOWN_BINARY_EXTS.has(urlExt) ? urlExt : (OS_DEFAULT_EXT[os] ?? urlExt ?? ".zip");
  const finalExt = ext === ".crx3" ? ".zip" : ext;

  return `chrome_${version}_${osName}_${archName}${finalExt}`;
}

async function fetchGitHubAssets(): Promise<Map<string, string>> {
  const assetsMap = new Map<string, string>();
  let page = 1;
  const perPage = 100;
  const token = process.env.GITHUB_TOKEN;
  
  const headers: Record<string, string> = {
    "User-Agent": "chromget-importer",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  while (true) {
    const url = `https://api.github.com/repos/jmsalazardev/chromget/releases?per_page=${perPage}&page=${page}`;
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        break;
      }
      const releases = await response.json() as any[];
      if (!Array.isArray(releases) || releases.length === 0) {
        break;
      }

      for (const release of releases) {
        if (Array.isArray(release.assets)) {
          for (const asset of release.assets) {
            if (asset.name && asset.browser_download_url) {
              assetsMap.set(asset.name, asset.browser_download_url);
            }
          }
        }
      }

      if (releases.length < perPage) {
        break;
      }
      page++;
    } catch (err: any) {
      break;
    }
  }

  return assetsMap;
}

