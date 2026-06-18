import * as p from "@clack/prompts";

/**
 * Cancel the current command with the standard message and exit code.
 */
export function cancel(): void {
  p.cancel("Operation cancelled.");
  process.exitCode = 130;
}
