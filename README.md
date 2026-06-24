# chromget

> CLI to download **Chrome for Testing** binaries across all platforms and versions.

[![npm](https://img.shields.io/npm/v/@jmsalazardev/chromget?color=4f8ef7&label=npm)](https://www.npmjs.com/package/@jmsalazardev/chromget)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/github/license/jmsalazardev/chromget)](./LICENSE)

---

> [!WARNING]
> **This is a pre-release version.** `chromget` is still under active development and no stable release has been published yet. APIs, CLI flags, and behavior may change without notice. Use it at your own risk and feel free to [open an issue](https://github.com/jmsalazardev/chromget/issues) if you find bugs or have suggestions.

---

## 🌐 Browse Releases Online

Don't want to use the CLI? You can browse, filter, and download Chrome binaries directly from your browser:

**👉 [jmsalazardev.github.io/chromget](https://jmsalazardev.github.io/chromget/)**

Filter by operating system, architecture, version number, and availability status — then download with a single click.

---

## Features

- 📦 Download Chrome binaries for **Windows**, **macOS**, and **Linux** from GitHub Releases
- 🔍 Filter by major version, OS, and architecture
- ⏩ Resume interrupted downloads automatically
- 📋 List all available versions in a formatted table
- 🔀 CRX3 → ZIP conversion out of the box
- 🖥️ Interactive prompts when no arguments are provided

---

## Supported Platforms

| Target        | OS      | Architecture |
|---------------|---------|-------------|
| `win_x86`     | Windows | x86 32-bit  |
| `win_x64`     | Windows | x64 64-bit  |
| `mac_x64`     | macOS   | Intel x64   |
| `mac_arm64`   | macOS   | Apple Silicon |
| `linux_x64`   | Linux   | x64 (deb)   |
| `linux_x64_rpm` | Linux | x64 (rpm)   |

---

## Installation

```bash
npm install -g @jmsalazardev/chromget
```

Or run without installing:

```bash
npx @jmsalazardev/chromget [command]
```

---

## Commands

### `download` *(default)*

Download Chrome binaries for one or more major versions.

```bash
chromget download [majors...] [options]
```

**Arguments**

| Argument   | Description |
|------------|-------------|
| `[majors...]` | Major version numbers to download (e.g. `148 147`). Leave empty for interactive mode. |

**Options**

| Flag | Description |
|------|-------------|
| `-o, --output <dir>` | Directory to save files (default: `./chrome-downloads`) |
| `-s, --os <targets...>` | Specific OS targets to download (e.g. `win_x64 linux_x64`) |
| `-f, --fail-fast` | Stop on first failure |
| `-t, --timeout <ms>` | Request timeout in milliseconds (default: `60000`) |
| `--dry-run` | Verify URL availability without downloading |

**Examples**

```bash
# Interactive mode — prompts for version and platform selection
chromget download

# Download Chrome 148 for all platforms
chromget download 148

# Download Chrome 147 and 146 for Windows x64 only
chromget download 147 146 --os win_x64

# Verify links without downloading
chromget download 148 --dry-run

# Save to a custom directory
chromget download 148 --output ./my-chrome-builds

# Download Linux builds with 30s timeout, stop on first error
chromget download 148 --os linux_x64 --timeout 30000 --fail-fast
```

---

### `list`

List all available Chrome versions in a formatted ASCII table, grouped by major version.

```bash
chromget list [majors...] [options]
```

**Arguments**

| Argument | Description |
|----------|-------------|
| `[majors...]` | Filter by specific major versions (e.g. `148 120`) |

**Examples**

```bash
# List all versions
chromget list

# List only version 148
chromget list 148
```

---

## Development

```bash
# Clone the repo
git clone https://github.com/jmsalazardev/chromget.git
cd chromget

# Install dependencies
npm install

# Run in development mode (no build needed)
npm run dev -- download 148

# Build
npm run build

# Type check
npm run typecheck
```

---

## Data Source

Chrome release information is fetched dynamically from GitHub Releases, where the compiled and verified binaries are mirrored.

---

## License

MIT © [jmsalazardev](https://github.com/jmsalazardev)
