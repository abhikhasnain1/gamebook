import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roles = [
  "open-1gb",
  "open-5gb",
  "materialize-selected",
  "digest-failure",
  "checksum-failure",
  "cancellation",
  "malformed",
  "traversal",
  "case-duplicate",
  "oversized-json",
  "decompression-bomb",
];

function parseArgs(args) {
  const options = {
    buildId: undefined,
    outputDir: resolve(root, "src-tauri/target/zip64-lazy-materialization-evidence"),
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--build-id":
        options.buildId = args[++index];
        break;
      case "--output-dir":
        options.outputDir = resolve(args[++index]);
        break;
      case "--help":
      case "-h":
        console.log("run-zip64-lazy-materialization --build-id REVISION [--output-dir DIR]");
        process.exit(0);
        break;
      default:
        assert.fail(`Unknown option: ${args[index]}`);
    }
  }
  assert.match(options.buildId ?? "", /^[a-f0-9]{40}$/, "--build-id requires an exact 40-character revision");
  return options;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function portableRelative(from, to) {
  return relative(from, to).replaceAll("\\", "/");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.outputDir, { recursive: true });
  execFileSync("cargo", [
    "build",
    "--release",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "zip64_lazy_materialization_spike",
  ], { cwd: root, stdio: "inherit" });

  const binary = resolve(root, "src-tauri/target/release/examples/zip64_lazy_materialization_spike.exe");
  const reports = [];
  const runStamp = Date.now();
  for (const [index, role] of roles.entries()) {
    const runId = `evidence-${role}-${runStamp + index}`;
    execFileSync(binary, [
      "--scenario", role,
      "--build-id", options.buildId,
      "--run-id", runId,
      "--output-dir", options.outputDir,
    ], { cwd: root, stdio: "inherit" });
    const reportPath = resolve(options.outputDir, `${runId}.json`);
    reports.push({
      id: runId,
      role,
      path: portableRelative(options.outputDir, reportPath),
      sha256: hashFile(reportPath),
    });
  }

  const manifest = {
    schema: "gamebook.zip64-lazy-materialization-evidence-manifest.v1",
    issue: 14,
    applicationBuild: {
      name: "gamebook",
      version: "0.5.3",
      sourceRevision: options.buildId,
      profile: "release",
    },
    binary: {
      path: portableRelative(options.outputDir, binary),
      bytes: statSync(binary).size,
      sha256: hashFile(binary),
    },
    reports,
  };
  const manifestPath = resolve(options.outputDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync(process.execPath, [
    resolve(root, "tools/spikes/verify-zip64-lazy-materialization-report.mjs"),
    "--manifest",
    manifestPath,
  ], { cwd: root, stdio: "inherit" });
  console.log(`Evidence manifest: ${manifestPath}`);
}

main();
