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
