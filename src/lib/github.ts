import type { ChromeDatabase, OsTarget } from "./types.js";

const REPO_OWNER = process.env.CHROMGET_REPO_OWNER || "jmsalazardev";
const REPO_NAME = process.env.CHROMGET_REPO_NAME || "chromget";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  published_at?: string;
  created_at?: string;
  assets?: GitHubAsset[];
}

/**
 * Fetches all releases from the GitHub repository and constructs a ChromeDatabase.
 */
export async function fetchDatabaseFromGitHub(): Promise<ChromeDatabase> {
  const db: ChromeDatabase = {};
  let page = 1;
  const perPage = 100;
  const token = process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    "User-Agent": "chromget-cli",
    "Accept": "application/vnd.github+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  while (true) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `GitHub API returned status ${response.status}: ${response.statusText}${
          errText ? ` - ${errText}` : ""
        }`,
      );
    }

    const releases = (await response.json()) as GitHubRelease[];
    if (!Array.isArray(releases) || releases.length === 0) {
      break;
    }

    for (const release of releases) {
      // Tags are e.g., chrome-74
      const majorMatch = release.tag_name.match(/^chrome-(\d+)$/);
      if (!majorMatch) continue;

      const releaseDate = release.published_at || release.created_at || new Date().toISOString();

      if (Array.isArray(release.assets)) {
        for (const asset of release.assets) {
          // Asset name pattern: chrome_<version>_<osName>_<archName>.<ext>
          const assetMatch = asset.name.match(
            /^chrome_([0-9.]+)_([a-zA-Z0-9]+)_([a-zA-Z0-9_]+)(\.[a-z0-9]+)$/i,
          );
          if (!assetMatch) continue;

          const [, version, osName, archName, ext] = assetMatch;
          let osTarget: OsTarget | null = null;

          if (osName === "win" && archName === "x86") {
            osTarget = "win_x86";
          } else if (osName === "win" && archName === "x64") {
            osTarget = "win_x64";
          } else if (osName === "mac" && archName === "x64") {
            osTarget = "mac_x64";
          } else if (osName === "mac" && archName === "arm64") {
            osTarget = "mac_arm64";
          } else if (osName === "linux" && archName === "x64") {
            if (ext === ".deb") {
              osTarget = "linux_x64";
            } else if (ext === ".rpm") {
              osTarget = "linux_x64_rpm";
            }
          }

          if (osTarget && version) {
            if (!db[version]) {
              db[version] = { releaseDate };
            }
            if (!db[version][osTarget]) {
              db[version][osTarget] = [];
            }
            const urls = db[version][osTarget] as string[];
            if (!urls.includes(asset.browser_download_url)) {
              urls.push(asset.browser_download_url);
            }
          }
        }
      }
    }

    if (releases.length < perPage) {
      break;
    }
    page++;
  }

  return db;
}
