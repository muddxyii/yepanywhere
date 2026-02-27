/**
 * JSONL file reading utilities.
 *
 * Shared helpers for reading JSONL session files with BOM handling
 * and partial reads (to avoid loading multi-MB files entirely).
 */

import { open, readFile } from "node:fs/promises";

/** Strip UTF-8 BOM if present (common on Windows). */
export function stripBom(str: string): string {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

/**
 * Read the first line of a file using a partial read.
 * Returns null for empty files or empty first lines.
 */
export async function readFirstLine(
  filePath: string,
  bufSize = 4096,
): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const buf = Buffer.alloc(bufSize);
    const { bytesRead } = await fd.read(buf, 0, bufSize, 0);
    if (bytesRead === 0) return null;

    const content = stripBom(buf.toString("utf-8", 0, bytesRead));
    const nl = content.indexOf("\n");
    const line = (nl > 0 ? content.slice(0, nl) : content).trim();
    return line || null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

/**
 * Read a file and return BOM-stripped lines.
 */
export async function readJsonlLines(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf-8");
  return stripBom(raw).trim().split("\n");
}
