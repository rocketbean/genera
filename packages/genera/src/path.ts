import { InvalidPathError } from "./errors";

/**
 * Normalize a user-supplied path into Genera's canonical form:
 * POSIX forward slashes, no leading slash, redundant segments collapsed,
 * Unicode in NFC, and traversal ("..") rejected for safety.
 *
 * Pure string logic on purpose — Node's `path` module is platform-specific and
 * absent in browsers, which would break isomorphism.
 */
export function normalizePath(input: string): string {
  if (typeof input !== "string") {
    throw new InvalidPathError("Path must be a string");
  }

  const unified = input.replace(/\\/g, "/").normalize("NFC");
  const segments: string[] = [];

  for (const raw of unified.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      throw new InvalidPathError(`Path traversal ("..") is not allowed: "${input}"`);
    }
    if (raw.includes("\0")) {
      throw new InvalidPathError(`Path may not contain null bytes: "${input}"`);
    }
    segments.push(raw);
  }

  return segments.join("/");
}

/** Join segments and normalize the result. */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** The final segment of a path, e.g. "a/b/c.txt" -> "c.txt". */
export function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Everything but the final segment, e.g. "a/b/c.txt" -> "a/b". */
export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}
