import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const projectRoot = process.cwd();
const testDistDir = path.join(os.tmpdir(), "flawless-sync-tests", `${process.pid}-${Date.now()}`);
const tscBin = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function collectTestFiles(directory) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }

    if (entry.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }

  return files;
}

mkdirSync(testDistDir, { recursive: true });

try {
  run(process.execPath, [tscBin, "-p", "tsconfig.tests.json", "--outDir", testDistDir]);

  writeFileSync(
    path.join(testDistDir, "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2),
  );

  const compiledTestFiles = collectTestFiles(path.join(testDistDir, "tests"));

  run(process.execPath, [
    "--test",
    "--experimental-test-isolation=none",
    "--test-concurrency=1",
    ...compiledTestFiles,
  ]);
} finally {
  try {
    rmSync(testDistDir, { recursive: true, force: true });
  } catch {
    // Windows may keep compiled test files locked for a short time after the runner exits.
  }
}
