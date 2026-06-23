#!/usr/bin/env bash
#
# Automatically create GitHub Releases and upload Chrome binaries using GitHub CLI (gh)
#
set -euo pipefail

# Directory where chrome binaries are downloaded
DOWNLOAD_DIR="/mnt/e/chrome-repo"

# 1. Verify GitHub CLI (gh) is installed
if ! command -v gh &> /dev/null; then
  echo "Error: GitHub CLI (gh) is not installed or not in PATH."
  echo "Please install it or make sure it is available."
  exit 1
fi

# 2. Verify GitHub CLI is authenticated
if ! gh auth status &>/dev/null; then
  echo "Error: GitHub CLI (gh) is not authenticated."
  echo "Please run 'gh auth login' to authenticate with your GitHub account."
  exit 1
fi

# 3. Ensure download directory exists
if [ ! -d "$DOWNLOAD_DIR" ]; then
  echo "Error: Download directory '$DOWNLOAD_DIR' does not exist."
  exit 1
fi

echo "Scanning '$DOWNLOAD_DIR' for Chrome binaries..."

# Allow filtering by a specific major version passed as argument (e.g., ./upload_releases.sh 85)
FILTER_MAJOR="${1:-}"

# Find all unique completed major versions
# Excludes *.part files (temporary downloads)
majors=$(find "$DOWNLOAD_DIR" -maxdepth 1 -name "chrome_*" -type f ! -name "*.part" -printf "%f\n" | \
  sed -E 's/^chrome_([0-9]+)\.[0-9.]+_.*/\1/' | \
  sort -n -u)

if [ -z "$majors" ]; then
  echo "No downloaded Chrome binaries found in '$DOWNLOAD_DIR'."
  exit 0
fi

if [ -n "$FILTER_MAJOR" ]; then
  # Verify the requested major version exists in our detected list
  if ! echo "$majors" | grep -qE "^${FILTER_MAJOR}$"; then
    echo "Error: No downloaded binaries found for major version '$FILTER_MAJOR' in '$DOWNLOAD_DIR'."
    exit 1
  fi
  majors="$FILTER_MAJOR"
  echo "Filtering release to major version: chrome-$FILTER_MAJOR"
else
  echo "Found the following completed Chrome major versions to release:"
  echo "$majors" | sed 's/^/chrome-/'
fi
echo "----------------------------------------"

for major in $majors; do
  tag="chrome-${major}"
  echo "Processing Chrome major version release: $tag..."
  
  # Find all finished files belonging to this major version
  # Matches chrome_<major>.<rest_of_version>_...
  files=()
  while IFS= read -r file; do
    if [ -f "$file" ]; then
      files+=("$file")
    fi
  done < <(find "$DOWNLOAD_DIR" -maxdepth 1 -name "chrome_${major}.*" -type f ! -name "*.part" ! -name "*.sha256")
  
  if [ ${#files[@]} -eq 0 ]; then
    echo "No files found for major version $major, skipping."
    continue
  fi
  
  # Check if release already exists on GitHub
  if gh release view "$tag" &>/dev/null; then
    echo "Release $tag already exists. Checking for missing assets..."
    
    # Fetch filenames of assets already uploaded to this release on GitHub
    uploaded_assets=$(gh release view "$tag" --json assets --jq '.assets[].name' 2>/dev/null || true)
    
    # Filter files array to only include files that aren't already on GitHub
    files_to_upload=()
    for f in "${files[@]}"; do
      basename_f=$(basename "$f")
      if echo "$uploaded_assets" | grep -Fqx "$basename_f" &>/dev/null; then
        echo "  - File $basename_f is already uploaded. Skipping."
      else
        files_to_upload+=("$f")
      fi
    done
    
    if [ ${#files_to_upload[@]} -eq 0 ]; then
      echo "  - No new files to upload for $tag."
    else
      echo "  - Uploading new assets to $tag..."
      gh release upload "$tag" "${files_to_upload[@]}"
    fi
  else
    echo "Creating new release $tag and uploading assets..."
    # Create the release and upload the assets in one command
    gh release create "$tag" "${files[@]}" \
      --title "$tag" \
      --notes "Automated download mirror for Chrome major version $major."
  fi
  
  echo "✓ Successfully processed $tag."
  echo "----------------------------------------"
done

echo "All releases and uploads completed successfully!"

