import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

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

const downloadDir = process.env.CHROME_REPO_DEST || "/mnt/e/chrome-repo";

// Validate prerequisites
function checkPrerequisites() {
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    console.error("Error: GitHub CLI (gh) is not installed or not in PATH.");
    console.error("Please install it or make sure it is available.");
    process.exit(1);
  }

  try {
    execSync("gh auth status", { stdio: "ignore" });
  } catch {
    console.error("Error: GitHub CLI (gh) is not authenticated.");
    console.error("Please run 'gh auth login' to authenticate with your GitHub account.");
    process.exit(1);
  }

  if (!fs.existsSync(downloadDir) || !fs.statSync(downloadDir).isDirectory()) {
    console.error(`Error: Download directory '${downloadDir}' does not exist.`);
    process.exit(1);
  }
}

// Check if an asset is already uploaded, accounting for GitHub's filename sanitization
function isAssetUploaded(localFile: string, uploadedAssets: string[]): boolean {
  const filename = path.basename(localFile);
  if (uploadedAssets.includes(filename)) {
    return true;
  }

  // Emulate GitHub CLI/API filename sanitization:
  // Non-alphanumeric, non-dot, non-underscore, non-hyphen are replaced by '.'
  // Consecutive dots are collapsed to '.'
  const sanitized = filename
    .replace(/[^a-zA-Z0-9_.-]/g, ".")
    .replace(/\.+/g, ".");

  if (uploadedAssets.includes(sanitized)) {
    return true;
  }

  // Fallback: canonicalize (alphanumeric lowercase only)
  const canonicalLocal = filename.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasCanonicalMatch = uploadedAssets.some(
    asset => asset.toLowerCase().replace(/[^a-z0-9]/g, "") === canonicalLocal
  );
  if (hasCanonicalMatch) {
    return true;
  }

  return false;
}

// Find all unique completed major versions in the download directory
function getMajors(filterMajor: string | null): number[] {
  const files = fs.readdirSync(downloadDir);
  const majorSet = new Set<number>();

  for (const file of files) {
    if (file.startsWith("chrome_") && !file.endsWith(".part") && !file.endsWith(".sha256")) {
      const rest = file.slice(7); // Remove "chrome_"
      const dotIndex = rest.indexOf(".");
      if (dotIndex !== -1) {
        const majorStr = rest.slice(0, dotIndex);
        const major = parseInt(majorStr, 10);
        if (!isNaN(major)) {
          if (filterMajor === null || major === parseInt(filterMajor, 10)) {
            majorSet.add(major);
          }
        }
      }
    }
  }

  return Array.from(majorSet).sort((a, b) => a - b);
}

async function main() {
  checkPrerequisites();

  const filterMajor = process.argv[2] || null;
  const majors = getMajors(filterMajor);

  if (majors.length === 0) {
    console.log(`No downloaded Chrome binaries found in '${downloadDir}'.`);
    return;
  }

  if (filterMajor) {
    console.log(`Filtering release to major version: chrome-${filterMajor}`);
  } else {
    console.log("Found the following completed Chrome major versions to release:");
    console.log(majors.map(m => `  - chrome-${m}`).join("\n"));
  }
  console.log("----------------------------------------");

  for (const major of majors) {
    const tag = `chrome-${major}`;
    console.log(`Processing Chrome major version release: ${tag}...`);

    // Find all files belonging to this major version
    const allFiles = fs.readdirSync(downloadDir);
    const filesToUpload: string[] = [];

    for (const file of allFiles) {
      if (file.startsWith(`chrome_${major}.`) && !file.endsWith(".part") && !file.endsWith(".sha256")) {
        filesToUpload.push(path.join(downloadDir, file));
      }
    }

    if (filesToUpload.length === 0) {
      console.log(`No files found for major version ${major}, skipping.`);
      continue;
    }

    // Check if release already exists on GitHub
    let releaseExists = false;
    let uploadedAssets: string[] = [];
    try {
      const viewResult = execSync(`gh release view "${tag}" --json assets`, { encoding: "utf8" });
      releaseExists = true;
      const data = JSON.parse(viewResult);
      if (data && Array.isArray(data.assets)) {
        uploadedAssets = data.assets.map((a: any) => a.name);
      }
    } catch {
      releaseExists = false;
    }

    if (releaseExists) {
      console.log(`Release ${tag} already exists. Checking for missing assets...`);
      const newFiles = filesToUpload.filter(f => !isAssetUploaded(f, uploadedAssets));

      if (newFiles.length === 0) {
        console.log(`  - No new files to upload for ${tag}.`);
      } else {
        console.log(`  - Uploading ${newFiles.length} new assets to ${tag}...`);
        const filesArgs = newFiles.map(f => `"${f}"`).join(" ");
        execSync(`gh release upload "${tag}" ${filesArgs}`, { stdio: "inherit" });
      }
    } else {
      console.log(`Creating new release ${tag} and uploading assets...`);
      const filesArgs = filesToUpload.map(f => `"${f}"`).join(" ");
      execSync(
        `gh release create "${tag}" ${filesArgs} --title "${tag}" --notes "Automated download mirror for Chrome major version ${major}."`,
        { stdio: "inherit" }
      );
    }

    console.log(`✓ Successfully processed ${tag}.`);
    console.log("----------------------------------------");
  }

  console.log("All releases and uploads completed successfully!");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
