import path from "node:path";

export function assertInsideBase(baseDir: string, candidate: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(candidate);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Unsafe path outside base: ${candidate}`);
  }
  return resolved;
}

export function safeRunId(input: string): string {
  if (!/^run_[a-zA-Z0-9_-]+$/.test(input)) {
    throw new Error("Invalid run id");
  }
  return input;
}

export function safeFileName(input: string): string {
  const name = path.basename(input).trim();
  if (name !== input || !name || name.startsWith(".") || name.includes("..")) {
    throw new Error("Invalid file name");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@()+, -]{0,159}$/.test(name)) {
    throw new Error("File name contains unsupported characters");
  }
  return name;
}

export function safeRelativePath(input: string): string {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) {
    throw new Error("Invalid relative path");
  }

  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Invalid relative path");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("Invalid relative path segment");
  }
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._@()+, -]{0,159}$/.test(segment)) {
      throw new Error("Relative path contains unsupported characters");
    }
  }
  return segments.join("/");
}
