import { Command } from "commander";
import pc from "picocolors";
import { runDownload } from "./commands/download.js";
import { runImport } from "./commands/import.js";
import { runCheck } from "./commands/check.js";
import { runList } from "./commands/list.js";

const program = new Command();

program
  .name("chromget")
  .description(
    "CLI to download Chrome binaries and manage their database",
  )
  .version("1.0.0");

program
  .command("download", { isDefault: true })
  .description("Download Chrome binaries (default)")
  .argument(
    "[majors...]",
    "Chrome major versions to download (e.g. 148 147). If omitted, runs interactively.",
  )
  .option("-o, --output <dir>", "Directory to save downloaded files")
  .option(
    "-s, --os <targets...>",
    "Operating system targets to download (win_x86, win_x64, mac_x64, mac_arm64, linux_x64, linux_x64_rpm)",
  )
  .option(
    "-f, --fail-fast",
    "Stop execution immediately on the first download failure",
  )
  .option("-t, --timeout <ms>", "Request timeout in milliseconds")
  .option(
    "--dry-run",
    "Verify link availability on the server without downloading files",
  )
  .action(
    async (
      majorsArg: string[],
      options: {
        output?: string;
        os?: string[];
        failFast?: boolean;
        timeout?: string;
        dryRun?: boolean;
      },
    ) => {
      const majors = majorsArg.map(Number).filter((n) => !isNaN(n));
      await runDownload(majors, options);
    },
  );

program
  .command("import")
  .description("Scrape and import Chrome versions from Slimjet archive page")
  .action(async () => {
    await runImport();
  });

program
  .command("check")
  .description("Verify health status of all Chrome download URLs and save to chrome.json")
  .option("--force", "Force verification of all URLs, ignoring the 1-hour cache skip logic")
  .option("-c, --concurrency <number>", "Number of concurrent requests")
  .option("-t, --timeout <ms>", "Request timeout in milliseconds")
  .action(async (options) => {
    await runCheck(options);
  });

program
  .command("list")
  .description("List all available Chrome versions in a formatted table")
  .argument("[majors...]", "Filter versions by Chrome major versions")
  .option("--online", "Only show versions that have at least one online platform")
  .option("--offline", "Only show versions that have at least one offline platform")
  .action(async (majorsArg: string[], options) => {
    const majors = majorsArg.map(Number).filter((n) => !isNaN(n));
    await runList(majors, options);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red(`Fatal Error: ${(err as Error).message}`));
  process.exitCode = 1;
});


