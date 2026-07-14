#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultCanonicalRoot = path.join(repoRoot, "data", "runs");
const defaultSourceRoots = [
  defaultCanonicalRoot,
  path.join(repoRoot, "apps", "server", "data", "runs")
];
const runIdPattern = /^run_[A-Za-z0-9_-]+$/;

function resolveFromRepo(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    canonicalRoot: defaultCanonicalRoot,
    sourceRoots: [],
    reportPath: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--canonical") {
      const value = argv[index + 1];
      if (!value) throw new Error("--canonical requires a path");
      options.canonicalRoot = resolveFromRepo(value);
      index += 1;
    } else if (argument === "--source") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source requires a path");
      options.sourceRoots.push(resolveFromRepo(value));
      index += 1;
    } else if (argument === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = resolveFromRepo(value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log([
        "Usage: node scripts/migrate-local-runs.mjs [options]",
        "",
        "Options:",
        "  --apply              Copy unique runs into the canonical root.",
        "  --canonical <path>   Override the canonical run root.",
        "  --source <path>      Add a source root; repeat for multiple roots.",
        "  --report <path>      Write the JSON report to a file.",
        "  --help               Show this help.",
        "",
        "Without --apply the command is a non-destructive dry run."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  options.canonicalRoot = path.normalize(options.canonicalRoot);
  options.sourceRoots = (options.sourceRoots.length ? options.sourceRoots : defaultSourceRoots)
    .map((root) => path.normalize(root));
  if (!options.sourceRoots.some((root) => root.toLowerCase() === options.canonicalRoot.toLowerCase())) {
    options.sourceRoots.unshift(options.canonicalRoot);
  }
  options.sourceRoots = [...new Map(options.sourceRoots.map((root) => [root.toLowerCase(), root])).values()];
  return options;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not supported: ${nextRelative}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, nextRelative));
    } else if (entry.isFile()) {
      files.push(nextRelative);
    }
  }
  return files;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function comparisonBytes(filePath, relativePath) {
  const data = await fs.readFile(filePath);
  if (relativePath.replace(/\\/g, "/") !== "manifest.json") return data;
  try {
    const manifest = JSON.parse(data.toString("utf8"));
    manifest.localDir = "<LOCAL_RUN_DIR>";
    return Buffer.from(JSON.stringify(manifest), "utf8");
  } catch {
    return data;
  }
}

async function hashRunDirectory(runDirectory) {
  const relativeFiles = await listFiles(runDirectory);
  const files = [];
  const aggregate = crypto.createHash("sha256");
  for (const relativePath of relativeFiles) {
    const filePath = path.join(runDirectory, relativePath);
    const data = await fs.readFile(filePath);
    const comparisonData = await comparisonBytes(filePath, relativePath);
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const fileHash = sha256(data);
    const comparisonHash = sha256(comparisonData);
    files.push({
      path: normalizedPath,
      size: data.byteLength,
      sha256: fileHash
    });
    aggregate.update(normalizedPath);
    aggregate.update("\0");
    aggregate.update(comparisonHash);
    aggregate.update("\n");
  }
  return {
    treeHash: aggregate.digest("hex"),
    fileCount: files.length,
    files
  };
}

async function inspectRun(runDirectory, directoryName) {
  if (!runIdPattern.test(directoryName)) {
    throw new Error("directory name is not a valid run ID");
  }
  const manifestPath = path.join(runDirectory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest is not an object");
  }
  if (manifest.id !== directoryName) {
    throw new Error(`manifest ID ${String(manifest.id)} does not match directory ${directoryName}`);
  }
  return {
    id: directoryName,
    manifest,
    hash: await hashRunDirectory(runDirectory)
  };
}

async function listRunDirectories(root) {
  if (!await pathExists(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function copyRun(sourceDirectory, destinationDirectory, manifest) {
  const parent = path.dirname(destinationDirectory);
  await fs.mkdir(parent, { recursive: true });
  const stagingDirectory = path.join(
    parent,
    `.${path.basename(destinationDirectory)}.migrate-${process.pid}-${crypto.randomBytes(5).toString("hex")}`
  );
  try {
    await fs.cp(sourceDirectory, stagingDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true
    });
    const migratedManifest = {
      ...manifest,
      localDir: destinationDirectory
    };
    await fs.writeFile(
      path.join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(migratedManifest, null, 2)}\n`,
      "utf8"
    );
    await fs.rename(stagingDirectory, destinationDirectory);
  } catch (error) {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function increment(summary, action) {
  summary[action] = (summary[action] || 0) + 1;
}

async function migrate(options) {
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? "apply" : "dry-run",
    repoRoot,
    canonicalRoot: options.canonicalRoot,
    sourceRoots: options.sourceRoots,
    summary: {},
    entries: []
  };
  const canonicalKey = options.canonicalRoot.toLowerCase();

  for (const sourceRoot of options.sourceRoots) {
    if (!await pathExists(sourceRoot)) {
      report.entries.push({
        source: sourceRoot,
        destination: options.canonicalRoot,
        id: null,
        action: "source-missing"
      });
      increment(report.summary, "source-missing");
      continue;
    }

    const runDirectories = await listRunDirectories(sourceRoot);
    for (const directory of runDirectories) {
      const sourceDirectory = path.join(sourceRoot, directory.name);
      const destinationDirectory = path.join(options.canonicalRoot, directory.name);
      try {
        const sourceRun = await inspectRun(sourceDirectory, directory.name);
        if (sourceRoot.toLowerCase() === canonicalKey) {
          report.entries.push({
            source: sourceDirectory,
            destination: destinationDirectory,
            id: sourceRun.id,
            action: "canonical-existing",
            sourceHash: sourceRun.hash.treeHash,
            sourceFiles: sourceRun.hash.files
          });
          increment(report.summary, "canonical-existing");
          continue;
        }

        if (await pathExists(destinationDirectory)) {
          let destinationRun;
          try {
            destinationRun = await inspectRun(destinationDirectory, directory.name);
          } catch (error) {
            report.entries.push({
              source: sourceDirectory,
              destination: destinationDirectory,
              id: sourceRun.id,
              action: "conflict",
              reason: `destination is invalid: ${error instanceof Error ? error.message : String(error)}`,
              sourceHash: sourceRun.hash.treeHash,
              sourceFiles: sourceRun.hash.files
            });
            increment(report.summary, "conflict");
            continue;
          }

          const identical = sourceRun.hash.treeHash === destinationRun.hash.treeHash;
          report.entries.push({
            source: sourceDirectory,
            destination: destinationDirectory,
            id: sourceRun.id,
            action: identical ? "duplicate-identical" : "conflict",
            reason: identical ? undefined : "duplicate ID has different file hashes",
            sourceHash: sourceRun.hash.treeHash,
            destinationHash: destinationRun.hash.treeHash,
            sourceFiles: sourceRun.hash.files,
            destinationFiles: destinationRun.hash.files
          });
          increment(report.summary, identical ? "duplicate-identical" : "conflict");
          continue;
        }

        if (options.apply) {
          await copyRun(sourceDirectory, destinationDirectory, sourceRun.manifest);
          const destinationRun = await inspectRun(destinationDirectory, directory.name);
          if (sourceRun.hash.treeHash !== destinationRun.hash.treeHash) {
            throw new Error("post-copy hash verification failed");
          }
          report.entries.push({
            source: sourceDirectory,
            destination: destinationDirectory,
            id: sourceRun.id,
            action: "copied",
            sourceHash: sourceRun.hash.treeHash,
            destinationHash: destinationRun.hash.treeHash,
            sourceFiles: sourceRun.hash.files,
            destinationFiles: destinationRun.hash.files
          });
          increment(report.summary, "copied");
        } else {
          report.entries.push({
            source: sourceDirectory,
            destination: destinationDirectory,
            id: sourceRun.id,
            action: "would-copy",
            sourceHash: sourceRun.hash.treeHash,
            sourceFiles: sourceRun.hash.files
          });
          increment(report.summary, "would-copy");
        }
      } catch (error) {
        report.entries.push({
          source: sourceDirectory,
          destination: destinationDirectory,
          id: directory.name,
          action: "invalid",
          reason: error instanceof Error ? error.message : String(error)
        });
        increment(report.summary, "invalid");
      }
    }
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await migrate(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.reportPath) {
    await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
    await fs.writeFile(options.reportPath, output, "utf8");
  }
  process.stdout.write(output);
  if ((report.summary.conflict || 0) > 0) process.exitCode = 2;
  else if ((report.summary.invalid || 0) > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
