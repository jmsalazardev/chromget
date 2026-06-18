import fs from "node:fs";

/**
 * Converts a CRX3 package buffer into a standard ZIP package buffer by stripping the CRX3 signature headers.
 */
export function crxToZip(crxBuffer: Buffer): Buffer {
  const magic = crxBuffer.toString("utf8", 0, 4);
  if (magic !== "Cr24") {
    throw new Error("Invalid CRX file: magic number 'Cr24' not found");
  }

  const version = crxBuffer.readUInt32LE(4);
  if (version !== 3) {
    throw new Error(
      `Unsupported CRX version: ${version}. Only CRX3 is supported.`,
    );
  }

  const headerLength = crxBuffer.readUInt32LE(8);
  const zipOffset = 12 + headerLength;

  if (zipOffset >= crxBuffer.length) {
    throw new Error("Invalid CRX file: header length exceeds file size");
  }

  return crxBuffer.subarray(zipOffset);
}

/**
 * Reads a CRX3 file from disk, converts it to ZIP, saves it, and deletes the original CRX3 file.
 */
export async function unpackCrxFile(
  crxPath: string,
  zipPath: string,
): Promise<void> {
  const crxBuffer = await fs.promises.readFile(crxPath);
  const zipBuffer = crxToZip(crxBuffer);
  await fs.promises.writeFile(zipPath, zipBuffer);
  await fs.promises.unlink(crxPath);
}
